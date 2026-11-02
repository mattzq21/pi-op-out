import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';
test('hold queue fades', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await page.evaluate(() => { window.op = []; const tick = () => { const b = document.querySelector('.pending-queue-hold button'); if (b) window.op.push(Number(getComputedStyle(b).opacity).toFixed(2) + (b.disabled ? 'd' : '')); if (window.op.length < 90) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await composer.fill('Message 1'); await composer.press('Enter');
  await page.waitForFunction(() => window.op.length >= 90, null, { timeout: 30000 });
  console.log('first message: ' + (await page.evaluate(() => window.op)).join(' '));
});
