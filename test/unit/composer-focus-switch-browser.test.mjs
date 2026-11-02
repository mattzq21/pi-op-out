import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';
test('the composer shows its focus without a gap when switching chats from the sidebar', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  const send = async text => { await composer.fill(text); await composer.press('Enter'); await page.getByText('Reply to ' + text).waitFor({ timeout: 30000 }); await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' }); await page.waitForTimeout(500); };
  await send('Message 1');
  await page.keyboard.press('Control+n'); await page.waitForTimeout(800);
  await send('Message 2');
  for (const name of ['Message 1', 'Message 2', 'Message 1']) {
    await page.evaluate(() => { window.f = []; const tick = () => { const c = document.querySelector('.composer'); const a = document.activeElement; window.f.push((c && (c.contains(document.activeElement) || c.classList.contains('focus-pending')) ? 'F' : '.') + (c?.classList.contains('focus-pending') ? 'p' : '') + (document.querySelector('.conversation-unowned') ? 'u' : '') + '[' + (a === document.body ? 'body' : a?.getAttribute('aria-label')?.slice(0, 12) ?? a?.tagName) + ']'); if (window.f.length < 40) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    await page.getByRole('button', { name: new RegExp('^' + name + ',') }).click();
    await page.waitForFunction(() => window.f.length >= 40);
    const frames = await page.evaluate(() => window.f);
    assert.deepEqual(frames.filter(frame => !frame.startsWith('F')), [], 'to ' + name + ': ' + frames.join(' '));
  }
});
