import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser, appWindow, trackBrowserStorage } from '../app-browser-fixture.mjs';

test('an unsent draft survives a full browser reload', async t => {
  const page = await appBrowser(t);
  await trackBrowserStorage(page);
  await page.getByRole('textbox', { name: 'Message piop' }).fill('Saved across a full reload 日本語');
  await page.evaluate(() => window.savedDraft());
  await page.reload();
  await page.getByRole('textbox', { name: 'Message piop' }).waitFor();
  await page.getByRole('button', { name: /^Saved across a full reload 日本語,/ }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Message piop' }).inputValue(), 'Saved across a full reload 日本語');
});

test('saving one window preserves drafts edited or cleared in another window', async t => {
  const first = await appBrowser(t);
  const second = await appWindow(first);
  await trackBrowserStorage(first);
  await trackBrowserStorage(second);
  const editor = page => page.getByRole('textbox', { name: 'Message piop' });
  await editor(first).fill('First window draft');
  await editor(second).fill('Second window draft');
  await first.evaluate(() => window.savedDraft());
  await second.evaluate(() => window.savedDraft());
  const stale = await appWindow(first);
  await trackBrowserStorage(stale);
  await stale.getByRole('button', { name: /^First window draft,/ }).click();
  assert.equal(await editor(stale).inputValue(), 'First window draft');
  assert.equal(await editor(second).inputValue(), 'Second window draft');
  await editor(second).fill('');
  assert.equal(await editor(second).inputValue(), '');
  await second.evaluate(() => window.savedDraft());
  await editor(stale).fill('Updated first window');
  await stale.evaluate(() => window.savedDraft());
  await first.reload();
  await first.getByRole('button', { name: /^Updated first window,/ }).click();
  assert.equal(await editor(first).inputValue(), 'Updated first window');
  const cleared = first.getByRole('button', { name: /^Second window draft,/ });
  if (await cleared.count()) {
    await cleared.click();
    assert.equal(await editor(first).inputValue(), '', 'another window must not restore cleared text');
  }
  assert.equal(await cleared.count(), 0);
});

test('clearing a saved draft keeps it empty after a full browser reload', async t => {
  const page = await appBrowser(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await trackBrowserStorage(page);
  await editor.fill('Remove this saved draft');
  await page.evaluate(() => window.savedDraft());
  await page.reload();
  await page.getByRole('button', { name: /^Remove this saved draft,/ }).click();
  assert.equal(await editor.inputValue(), 'Remove this saved draft');
  await trackBrowserStorage(page);
  await editor.fill('');
  await page.evaluate(() => window.savedDraft());
  await page.reload();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), '');
  assert.equal(await page.getByRole('button', { name: /^Remove this saved draft,/ }).count(), 0);
});

test('local and remote drafts remain separate across full browser reloads', async t => {
  const hostId = crypto.randomUUID();
  const page = await appBrowser(t, { remotes: [{ id: hostId, name: 'Remote', target: 'draft-browser-remote' }] });
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  const home = page.url();
  await trackBrowserStorage(page);
  await editor.fill('Local unsent 日本語\nsecond line');
  await page.evaluate(() => window.savedDraft());
  await page.goto(home + '?target=' + encodeURIComponent(JSON.stringify({ hostId })));
  await editor.waitFor();
  assert.equal(await editor.inputValue(), '');
  await trackBrowserStorage(page);
  await editor.fill('Remote unsent draft');
  await page.evaluate(() => window.savedDraft());
  await page.goto(home);
  await page.getByRole('button', { name: /^Local unsent 日本語/ }).click();
  assert.equal(await editor.inputValue(), 'Local unsent 日本語\nsecond line');
  assert.equal(await page.getByRole('button', { name: 'Host: Local', exact: true }).count(), 1);
  await page.getByRole('button', { name: /^Remote unsent draft,/ }).click();
  assert.equal(await editor.inputValue(), 'Remote unsent draft');
  assert.equal(await page.getByRole('button', { name: 'Host: Remote', exact: true }).count(), 1);
});
