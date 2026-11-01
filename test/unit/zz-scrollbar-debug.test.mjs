import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startupPage } from '../startup-browser-fixture.mjs';

const scenarios = {
  click: async (h) => { await h.mv(h.x, h.thumbY); await h.down(); await h.up(); },
  drag: async (h) => { await h.mv(h.x, h.thumbY); await h.down(); for (let i = 1; i <= 10; i++) await h.mv(h.x, h.thumbY - i * 20); await h.up(); },
  dragReleaseInside: async (h) => { await h.mv(h.x, h.thumbY); await h.down(); for (let i = 1; i <= 10; i++) await h.mv(h.x - i * 30, h.thumbY - i * 20); await h.up(); },
  trackClick: async (h) => { await h.mv(h.x, h.box.top + 20); await h.down(); await h.up(); },
};

for (const [name, run] of Object.entries(scenarios)) test('scrollbar does not follow the pointer after ' + name, async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/chat-scroll-browser.tsx', ready: '.messages' });
  const messages = page.locator('.messages');
  await page.evaluate(c => { const s = document.createElement('style'); s.textContent = c; document.head.append(s); }, readFileSync('clients/ui/index.css', 'utf8'));
  await messages.evaluate(e => { e.style.display = 'none'; e.offsetHeight; e.style.display = ''; });
  await page.evaluate(() => { window.__ev = []; for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) addEventListener(t, e => window.__ev.push(t), true); });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = await messages.evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, left: r.left, st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight, cw: e.clientWidth, ow: e.offsetWidth }; });
  const x = box.left + box.cw + (box.ow - box.cw) / 2;
  const thumbY = box.top + box.ch * (box.st + box.ch / 2) / box.sh;
  const [left, top] = await page._xOrigin();
  const input = await page._context._session.xInput();
  const mv = async (vx, vy) => { await input.request({ action: 'move', x: Math.round(left + vx), y: Math.round(top + vy) }); await delay(15); };
  const down = async () => { await input.request({ action: 'button', button: 1, down: true }); await delay(60); };
  const up = async () => { await input.request({ action: 'button', button: 1, down: false }); await delay(60); };
  await run({ mv, down, up, x, thumbY, box });
  await delay(100);
  const before = await messages.evaluate(e => e.scrollTop);
  await mv(box.left + 50, box.top + 400);
  for (let dx = -20; dx <= 20; dx += 4) await mv(x + dx, box.top + 40);
  await delay(150);
  const after = await messages.evaluate(e => e.scrollTop);
  console.log('[DEBUG-sb1]', name, 'events', await page.evaluate(() => window.__ev.join(',')), 'before', before, 'after', after);
  assert.ok(Math.abs(after - before) <= 2, `scroll moved from ${before} to ${after}`);
});
