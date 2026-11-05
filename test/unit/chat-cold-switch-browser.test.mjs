import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('switching to a chat not opened since start shows the old chat until the new one is ready, never an empty chat', { timeout: 180000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  const send = async text => { await composer.fill(text); await composer.press('Enter'); await page.getByText('Reply to ' + text).waitFor({ timeout: 30000 }); await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' }); await page.waitForTimeout(500); };
  for (const [index, text] of ['Message 1', 'Message 2', 'Message 3'].entries()) {
    if (index) { await page.keyboard.press('Control+n'); await page.waitForTimeout(800); }
    await send(text);
  }
  await page.reload();
  await composer.waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const results = {};
  for (const name of ['Message 1', 'Message 2']) {
    await page.evaluate(name => {
      window.frames = []; const start = performance.now();
      const tick = () => {
                const shown = [...document.querySelectorAll('.conversation .user-message .markdown-content')].map(element => element.textContent.trim());
        window.frames.push({ time: Math.round(performance.now() - start), empty: Boolean(document.querySelector('.empty-chat')), toolbar: Boolean(document.querySelector('.new-chat-project')), hold: Boolean(document.querySelector('.pending-queue-hold')), chat: shown.at(-1) ?? null });
        if (performance.now() - start < 1500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, name);
    await page.getByRole('button', { name: new RegExp('^' + name + ',') }).click();
    await page.waitForTimeout(1700);
    const frames = await page.evaluate(() => window.frames);
    const visible = frames;
    results[name] = visible.filter((frame, index) => index === 0 || JSON.stringify({ ...frame, time: 0 }) !== JSON.stringify({ ...visible[index - 1], time: 0 })).map(frame => `${frame.time}ms chat=${frame.chat}${frame.empty ? ' EMPTY' : ''}${frame.toolbar ? ' TOOLBAR' : ''}${frame.hold ? '' : ' NO-HOLD'}`);
  }
  for (const [name, frames] of Object.entries(results)) assert.deepEqual(frames.filter(frame => / EMPTY| TOOLBAR| NO-HOLD|chat=null/.test(frame)), [], name + ': ' + frames.join(' | '));
});
