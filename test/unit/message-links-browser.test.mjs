import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';

async function linkPage(t, content, status = 0) {
  const native = await nativeFileCommand(t, { launcher: { status } });
  let finished = 0;
  const waiters = [];
  const launchFinished = count => finished >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve }));
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/message-links-browser.tsx', ready: 'article', holdStorage: false,
    prepare: async page => {
      await page.exposeFunction('messageContent', () => content);
      await page.exposeFunction('nativeCommand', async (command, args) => {
        try { return await native.invoke(command, args); }
        finally {
          if (command === 'open_external_url') { finished++; for (const waiter of waiters) if (finished >= waiter.count) waiter.resolve(); }
        }
      });
    },
  });
  return { page, launched: launchFinished(1), launchFinished, launchedTargets: native.launchedTargets, launcherDirectory: native.directory };
}

test('middle clicking a web link prevents navigation and does not launch a browser', async t => {
  const { page, launchedTargets } = await linkPage(t, '[web](https://example.com/a)');
  const initial = page.url();
  const navigations = [];
  await page.context().route('https://example.com/**', route => { navigations.push(route.request().url()); return route.fulfill({ body: 'Unexpected navigation' }); });
  await page.evaluate(() => document.addEventListener('auxclick', event => {
    queueMicrotask(() => { window.lastAuxClick = { prevented: event.defaultPrevented, trusted: event.isTrusted }; });
  }, { once: true }));
  await page.getByRole('link', { name: 'web', exact: true }).click({ button: 'middle' });
  assert.deepEqual(await page.evaluate(() => window.lastAuxClick), { prevented: true, trusted: true });
  assert.equal(page.url(), initial);
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(navigations, []);
  assert.deepEqual(await launchedTargets(), []);
});

test('web links send the full URL to the system launcher', async t => {
  const { page, launched, launchedTargets } = await linkPage(t, '[web](https://example.com/a?x=1&y=2#section)');
  const initial = page.url();
  await page.getByRole('link', { name: 'web', exact: true }).click();
  await launched;
  assert.deepEqual(await launchedTargets(), ['https://example.com/a?x=1&y=2#section']);
  assert.equal(page.url(), initial);
});

test('a system launcher failure is shown beside the message link', async t => {
  const { page, launched, launchedTargets } = await linkPage(t, '[web](https://example.com/a)', 23);
  await page.getByRole('link', { name: 'web', exact: true }).click();
  const error = page.getByRole('alert');
  await error.waitFor();
  assert.match(await error.textContent(), /Could not open link:.*xdg-open failed.*23/);
  assert.ok((await error.textContent()).includes('https://example.com/a'));
  await launched;
  assert.deepEqual(await launchedTargets(), ['https://example.com/a']);
});

test('opening a link again after the system launcher is fixed removes the earlier error', async t => {
  const { page, launchFinished, launchedTargets, launcherDirectory } = await linkPage(t, '[web](https://example.com/a)', 23);
  const link = page.getByRole('link', { name: 'web', exact: true });
  await link.click();
  await page.getByRole('alert').waitFor();
  await writeFile(join(launcherDirectory, 'xdg-open'), "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$PIOP_TEST_LAUNCH_LOG\"\n", { mode: 0o755 });
  await link.click();
  await launchFinished(2);
  assert.deepEqual(await launchedTargets(), ['https://example.com/a', 'https://example.com/a']);
  assert.equal(await page.getByRole('alert').count(), 0);
});

test('relative and non-web destinations stay readable without active links', async t => {
  const { page, launchedTargets } = await linkPage(t, '[relative](/local/file) [mail](mailto:a@example.com)');
  assert.match(await page.getByRole('article').textContent(), /relative/);
  assert.match(await page.getByRole('article').textContent(), /mail/);
  assert.equal(await page.getByRole('link').count(), 0);
  assert.deepEqual(await launchedTargets(), []);
});
