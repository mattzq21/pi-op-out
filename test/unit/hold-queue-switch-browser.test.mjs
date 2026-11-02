import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';
test('switching chats does not darken Hold queue while the chat connects, also when connecting is slow', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  const send = async text => { await composer.fill(text); await composer.press('Enter'); await page.getByText('Reply to ' + text).waitFor({ timeout: 30000 }); await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' }); await page.waitForTimeout(500); };
  await send('Message 1');
  await page.keyboard.press('Control+n'); await page.waitForTimeout(800);
  await send('Message 2');
  await page.evaluate(() => { const original = window.nativeCommand; window.nativeCommand = async (command, args) => { if (command === 'daemon_invoke') await new Promise(resolve => setTimeout(resolve, 300)); return original(command, args); }; });
  for (const name of ['Message 1', 'Message 2', 'Message 1']) {
    await page.evaluate(() => { window.op = []; const tick = () => { const b = document.querySelector('.pending-queue-hold button'); const stack = document.querySelector('.composer-stack'); window.op.push(b ? Number(getComputedStyle(b).opacity).toFixed(2) + (b.disabled ? 'd' : '') + (stack?.classList.contains('composer-settling') ? 's' : '') : '-'); if (window.op.length < 150) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    await page.getByRole('button', { name: new RegExp('^' + name + ',') }).click();
    await page.waitForFunction(() => window.op.length >= 150);
    const frames = await page.evaluate(() => window.op);
    assert.deepEqual(frames.filter(frame => frame !== '-' && !frame.startsWith('1.00')), [], 'to ' + name + ': ' + frames.join(' '));
  }
});
