import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { appBrowser } from '../app-browser-fixture.mjs';

test('[DEBUG-sb1] app scrollbar does not follow the pointer after release', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  for (let i = 0; i < 10; i++) {
    await composer.fill('Message ' + i + '\n' + 'line\n'.repeat(8));
    await composer.press('Enter');
    await page.getByText('Reply to Message ' + i, { exact: false }).first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  }
  const messages = page.locator('.main-chat .messages').first();
  const [left, top] = await page._xOrigin();
  const input = await page._context._session.xInput();
  const mv = async (vx, vy) => { await input.request({ action: 'move', x: Math.round(left + vx), y: Math.round(top + vy) }); await delay(15); };
  const down = async () => { await input.request({ action: 'button', button: 1, down: true }); await delay(80); };
  const up = async () => { await input.request({ action: 'button', button: 1, down: false }); await delay(100); };
  const geometry = () => messages.evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, left: r.left, st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight, cw: e.clientWidth, ow: e.offsetWidth }; });
  await page.setViewportSize?.({ width: 1280, height: 720 }).catch(() => {});
  // Probe: log DOM mutations made during trusted pointerdown dispatch.
  await page.evaluate(() => {
    window.__mut = [];
    let active = false;
    const mo = new MutationObserver(list => { if (active) for (const m of list) window.__mut.push(m.type + ' ' + (m.target.className || m.target.nodeName) + ' ' + (m.attributeName || '') + ' +' + m.addedNodes.length + ' -' + m.removedNodes.length); });
    mo.observe(document, { subtree: true, childList: true, attributes: true });
    addEventListener('pointerdown', e => { if (!e.isTrusted) return; active = true; window.__pd = document.elementFromPoint(e.clientX, e.clientY); }, true);
    addEventListener('pointerdown', e => { if (!e.isTrusted) return; const after = document.elementFromPoint(e.clientX, e.clientY); window.__mut.push(...mo.takeRecords().map(m => m.type + ' ' + (m.target.className || m.target.nodeName) + ' ' + (m.attributeName || ''))); if (after !== window.__pd) window.__mut.push('HIT CHANGED ' + (window.__pd?.className) + ' -> ' + (after?.className)); active = false; }, false);
  });
  const scrollers = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.offsetWidth - e.clientWidth - e.clientLeft * 2 > 4 && e.scrollHeight > e.clientHeight + 20).map((e, i) => { e.dataset.sbProbe = String(i); const r = e.getBoundingClientRect(); return { id: String(i), cls: e.className, top: r.top, left: r.left, ch: e.clientHeight, cw: e.clientWidth, ow: e.offsetWidth, cl: e.clientLeft }; }));
  console.log('[DEBUG-sb1] scrollers', JSON.stringify(scrollers));
  const sc = scrollers[0]; const sel = '[data-sb-probe="0"]';
  const x = sc.left + sc.cl + sc.cw + (sc.ow - sc.cw - 2 * sc.cl) / 2;
  const thumb = async () => { const [st, sh] = await page.evaluate(sel => { const e = document.querySelector(sel); return [e.scrollTop, e.scrollHeight]; }, sel); return sc.top + sc.ch * (st + sc.ch / 2) / sh; };
  const drags = {
    toTop: async y => { for (let i = 1; i <= 20; i++) await mv(x, y - (y - 2) * i / 20); },
    pastTop: async y => { for (let i = 1; i <= 20; i++) await mv(x, y - (y + 60) * i / 20); },
    toBottom: async y => { for (let i = 1; i <= 20; i++) await mv(x, y + (sc.ch - y) * i / 20); },
    pastBottom: async y => { for (let i = 1; i <= 20; i++) await mv(x, y + (sc.ch + 60 - y) * i / 20); },
    pastRight: async y => { for (let i = 1; i <= 10; i++) await mv(x + i * 10, y - i * 20); },
    fast: async y => { await mv(x, y - 300); await mv(x, y + 200); },
    upDown: async y => { for (let i = 1; i <= 10; i++) await mv(x, y - i * 30); for (let i = 1; i <= 10; i++) await mv(x, y - 300 + i * 30); },
  };
  const failures = [];
  for (const [name, drag] of Object.entries(drags)) {
    await page.evaluate(sel => { const e = document.querySelector(sel); e.scrollTop = (e.scrollHeight - e.clientHeight) / 2; }, sel);
    await delay(150);
    await page.evaluate(() => { window.__mut = []; });
    const y = await thumb();
    await mv(x, y); await down(); await drag(y); await delay(50); await up();
    await mv(sc.left + 100, 300); await delay(100);
    const before = await page.evaluate(sel => document.querySelector(sel).scrollTop, sel);
    for (let dx = -20; dx <= 20; dx += 4) await mv(x + dx, sc.top + 15);
    for (let dx = -20; dx <= 20; dx += 4) await mv(x + dx, sc.top + sc.ch - 15);
    await delay(150);
    const after = await page.evaluate(sel => document.querySelector(sel).scrollTop, sel);
    console.log('[DEBUG-sb1]', name, 'before', before, 'after', after, 'mutations', (await page.evaluate(() => window.__mut)).length);
    if (Math.abs(after - before) > 2) failures.push(name);
    await mv(sc.left + 100, 300);
  }
  assert.deepEqual(failures, []);
});
