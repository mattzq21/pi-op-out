import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startupPage } from '../startup-browser-fixture.mjs';

test('[DEBUG-sb1] minimal', async t => {
  const page = await startupPage(t, 'production', { entryPoint: '/tmp/sbdbg/page.tsx', ready: '#s' });
  const [left, top] = await page._xOrigin();
  const input = await page._context._session.xInput();
  const mv = async (vx, vy) => { await input.request({ action: 'move', x: Math.round(left + vx), y: Math.round(top + vy) }); await delay(15); };
  const results = {};
  for (const mode of ['none', 'classColor', 'classWidth', 'cover', 'overflow', 'attrParent']) {
    await page.evaluate(m => { document.getElementById('s').scrollTop = 1800; window.setMode(m); document.getElementById('s').classList.remove('alt', 'wide'); }, mode);
    await delay(100);
    await mv(394, 200);
    await input.request({ action: 'button', button: 1, down: true }); await delay(80);
    await input.request({ action: 'button', button: 1, down: false }); await delay(100);
    await page.evaluate(() => window.setMode('none'));
    const before = await page.evaluate(() => document.getElementById('s').scrollTop);
    await mv(200, 20);
    for (let dx = -20; dx <= 10; dx += 3) await mv(394 + dx, 20);
    await delay(100);
    const after = await page.evaluate(() => document.getElementById('s').scrollTop);
    results[mode] = [before, after];
    await mv(200, 300);
  }
  console.log('[DEBUG-sb1]', JSON.stringify(results));
});
