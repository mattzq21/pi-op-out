import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser, appWindow, trackBrowserStorage } from '../app-browser-fixture.mjs';

test('drafts survive reloads and keep the newest edits', { timeout: 90000 }, async t => {
  const page = await appBrowser(t);
  await t.test('saving waits for database opens started before explicit storage tracking', async () => {
    await page.evaluate(async () => {
      const open = indexedDB.open('storage-open-probe', 1);
      window.probeDatabase = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const upgrade = indexedDB.open('storage-open-probe', 2);
      window.probeUpgrade = new Promise((resolve, reject) => { upgrade.onsuccess = () => resolve(upgrade.result); upgrade.onerror = () => reject(upgrade.error); });
      await new Promise(resolve => { upgrade.onblocked = resolve; });
    });
    try {
      await trackBrowserStorage(page);
      await page.evaluate(() => {
        window.probeSaved = false;
        window.probeSaving = window.savedDraft().then(() => { window.probeSaved = true; });
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.probeSaved), false, 'storage cannot be settled while an earlier database open is blocked');
    } finally {
      await page.evaluate(async () => {
        window.probeDatabase.close();
        (await window.probeUpgrade).close();
        await window.probeSaving;
      });
    }
  });

  await t.test('an unsent draft survives a full browser reload', { timeout: 30000 }, async () => {
    await trackBrowserStorage(page);
    await page.getByRole('textbox', { name: 'Message piop' }).fill('Saved across a full reload 日本語');
    await page.evaluate(() => window.savedDraft());
    await page.reload();
    await page.getByRole('textbox', { name: 'Message piop' }).waitFor();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Message piop' }).inputValue(), 'Saved across a full reload 日本語');
  });

  await t.test('clearing a saved draft keeps it empty after a full browser reload', { timeout: 30000 }, async () => {
    const editor = page.getByRole('textbox', { name: 'Message piop' });
    await trackBrowserStorage(page);
    await editor.fill('Remove this saved draft');
    await page.evaluate(() => window.savedDraft());
    await page.reload();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    assert.equal(await editor.inputValue(), 'Remove this saved draft');
    await trackBrowserStorage(page);
    await editor.fill('');
    await page.evaluate(() => window.savedDraft());
    await page.reload();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), '');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    assert.equal(await editor.inputValue(), '');
  });

  await t.test('an older edit saved last in another window does not replace a newer edit to the same draft', { timeout: 30000 }, async () => {
    const older = page;
    await trackBrowserStorage(older);
    const editor = page => page.getByRole('textbox', { name: 'Message piop' });
    await editor(older).fill('Shared draft');
    await older.evaluate(() => window.savedDraft());
    const newer = await appWindow(older);
    await trackBrowserStorage(newer);
    await newer.getByRole('button', { name: 'New conversation', exact: true }).click();
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
    await fresh.getByRole('button', { name: 'New conversation', exact: true }).click();
    assert.equal(await editor(fresh).inputValue(), 'Newer edit');
  });
});

test('saving one window preserves drafts edited or cleared in another window', async t => {
  const first = await appBrowser(t);
  const second = await appWindow(first);
  await trackBrowserStorage(first);
  await trackBrowserStorage(second);
  const editor = page => page.getByRole('textbox', { name: 'Message piop' });
  // The newest unsent chat is the one New conversation reopens.
  await editor(second).fill('Second window draft');
  await editor(first).fill('First window draft');
  await first.evaluate(() => window.savedDraft());
  await second.evaluate(() => window.savedDraft());
  const stale = await appWindow(first);
  await trackBrowserStorage(stale);
  await stale.getByRole('button', { name: 'New conversation', exact: true }).click();
  assert.equal(await editor(stale).inputValue(), 'First window draft');
  assert.equal(await editor(second).inputValue(), 'Second window draft');
  await editor(second).fill('');
  assert.equal(await editor(second).inputValue(), '');
  await second.evaluate(() => window.savedDraft());
  await editor(stale).fill('Updated first window');
  await stale.evaluate(() => window.savedDraft());
  await first.reload();
  await first.getByRole('button', { name: 'New conversation', exact: true }).click();
  assert.equal(await editor(first).inputValue(), 'Updated first window', 'another window must not restore cleared text');
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
  await editor.waitFor();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  assert.equal(await editor.inputValue(), 'Local unsent 日本語\nsecond line');
  assert.equal(await page.getByRole('button', { name: 'Host: Local', exact: true }).count(), 1);
  await page.goto(home + '?target=' + encodeURIComponent(JSON.stringify({ hostId })));
  await editor.waitFor();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  assert.equal(await editor.inputValue(), 'Remote unsent draft');
  assert.equal(await page.getByRole('button', { name: 'Host: Remote', exact: true }).count(), 1);
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
