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

test('an older edit saved last in another window does not replace a newer edit to the same draft', async t => {
  const older = await appBrowser(t);
  await trackBrowserStorage(older);
  const editor = page => page.getByRole('textbox', { name: 'Message piop' });
  await editor(older).fill('Shared draft');
  await older.evaluate(() => window.savedDraft());
  const newer = await appWindow(older);
  await trackBrowserStorage(newer);
  await newer.getByRole('button', { name: /^Shared draft,/ }).click();
  assert.equal(await editor(newer).inputValue(), 'Shared draft');
  await holdBrowserClock(older, Date.UTC(2030, 0, 1, 12, 0));
  await holdBrowserClock(newer, Date.UTC(2030, 0, 1, 12, 1));
  await editor(older).fill('Older edit');
  await editor(newer).fill('Newer edit');
  await newer.evaluate(() => window.savedDraft());
  await older.evaluate(() => window.savedDraft());
  await older.evaluate(() => window.releaseBrowserClock());
  await newer.evaluate(() => window.releaseBrowserClock());
  assert.equal(await editor(older).inputValue(), 'Newer edit');
  const fresh = await appWindow(older);
  await fresh.getByRole('button', { name: /^Newer edit,/ }).click();
  assert.equal(await editor(fresh).inputValue(), 'Newer edit');
  assert.equal(await fresh.getByRole('button', { name: /^Older edit,/ }).count(), 0);
});

// Fixes the page clock and holds its timers, so the page saves only when the test makes it hidden.
async function holdBrowserClock(page, now) {
  await page.evaluate(now => {
    const { setTimeout, clearTimeout } = window, realNow = Date.now, held = new Map();
    let next = -1;
    Date.now = () => now;
    window.setTimeout = (run, delay, ...args) => { held.set(next, () => run(...args)); return next--; };
    window.clearTimeout = id => { if (!held.delete(id)) clearTimeout(id); };
    window.releaseBrowserClock = () => {
      Object.assign(window, { setTimeout, clearTimeout });
      Date.now = realNow;
      for (const run of held.values()) setTimeout(run);
    };
  }, now);
}
