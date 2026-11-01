import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startupPage } from '../startup-browser-fixture.mjs';

test('a right click during a scrollbar thumb drag does not leave the thumb following the pointer', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/scrollbar-release-browser.tsx', ready: '#scroller' });
  const scroller = page.locator('#scroller');
  const { right, gutter } = await scroller.evaluate(element => { element.scrollTop = 1800; return { right: element.clientWidth, gutter: element.offsetWidth - element.clientWidth }; });
  const x = right + gutter / 2;
  const [left, top] = await page._xOrigin();
  const input = await page._context._session.xInput();
  const move = async (vx, vy) => { await input.request({ action: 'move', x: Math.round(left + vx), y: Math.round(top + vy) }); await delay(20); };
  const button = async (number, down) => { await input.request({ action: 'button', button: number, down }); await delay(80); };
  await move(x, 200);
  await button(1, true);
  await move(x, 180); await move(200, 160);
  await button(3, true); await button(3, false);
  await button(1, false);
  await move(200, 300);
  const position = await scroller.evaluate(element => element.scrollTop);
  for (let dx = -20; dx <= 10; dx += 3) await move(x + dx, 20);
  await delay(150);
  assert.equal(await scroller.evaluate(element => element.scrollTop), position, 'hovering the scrollbar does not scroll');
});
