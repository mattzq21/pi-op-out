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
  const failures = [];
  for (const sc of scrollers) {
    const sel = '[data-sb-probe="' + sc.id + '"]';
    const st0 = await page.evaluate(sel => { const e = document.querySelector(sel); e.scrollTop = (e.scrollHeight - e.clientHeight) / 2; return [e.scrollTop, e.scrollHeight]; }, sel);
    await delay(100);
    const x = sc.left + sc.cl + sc.cw + (sc.ow - sc.cw - 2 * sc.cl) / 2;
    const thumbY = sc.top + sc.ch * (st0[0] + sc.ch / 2) / st0[1];
    await page.evaluate(() => { window.__mut = []; });
    await mv(x, thumbY); await down(); await up();
    const before = await page.evaluate(sel => document.querySelector(sel).scrollTop, sel);
    await mv(x - 100, thumbY);
    for (let dx = -20; dx <= 20; dx += 4) await mv(x + dx, sc.top + 15);
    await delay(150);
    const after = await page.evaluate(sel => document.querySelector(sel).scrollTop, sel);
    console.log('[DEBUG-sb1]', sc.cls, 'before', before, 'after', after, 'mutations', JSON.stringify(await page.evaluate(() => window.__mut)));
    if (Math.abs(after - before) > 2) failures.push(sc.cls);
    await mv(sc.left + 20, sc.top + 100);
  }
  assert.deepEqual(failures, []);
});
