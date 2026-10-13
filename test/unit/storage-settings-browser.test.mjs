import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { daemonClient } from '../daemon-client.mjs';
import { startupPage } from '../startup-browser-fixture.mjs';

test('storage warns when an archived transcript has damaged content', async t => {
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Damaged chat' } }) + '\n' }),
  }));
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'storage-ui-test' });
  const report = await daemon.invoke('storage_report');
  const archived = report.hosts.find(host => host.hostId === 'local').archives.find(chat => chat.name === 'Damaged chat');
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/storage-settings-browser.tsx', ready: '[aria-label="Permanently delete Damaged chat"]', holdStorage: false,
    prepare: page => page.exposeFunction('storageCommand', (command, args) => {
      assert.equal(command, 'daemon_invoke');
      return daemon.invoke(args.command, args.args);
    }),
  });
  await appendFile(archived.path, 'not JSON\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const summary = page.locator('summary').filter({ hasText: /^Storage coverage is incomplete/ });
  await summary.waitFor();
  assert.match(await summary.textContent(), /\d+ warnings?/);
  const warning = summary.locator('..').locator('p').filter({ hasText: archived.path });
  assert.equal(await warning.isVisible(), false);
  await summary.click();
  await warning.waitFor();
  assert.match(await warning.textContent(), /session provenance is incomplete/);
});
