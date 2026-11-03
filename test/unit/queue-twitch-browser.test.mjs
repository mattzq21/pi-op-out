import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('queueing a message moves the chat history once, in the frame its queue row appears, and shows no interrupted message', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  for (let index = 1; index <= 5; index++) {
    await composer.fill('Message ' + index + ' ' + 'words '.repeat(40));
    await composer.press('Enter');
    await page.getByText('Reply to Message ' + index).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  }
  await page.getByRole('button', { name: 'Hold queue', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await page.evaluate(() => {
    window.frames = [];
    const channel = new MessageChannel();
    const afterPaint = () => requestAnimationFrame(() => channel.port2.postMessage(null));
    channel.port1.onmessage = () => {
      const last = [...document.querySelectorAll('.conversation article')].at(-1);
      window.frames.push({ lastBottom: Math.round(last.getBoundingClientRect().bottom), queued: document.querySelectorAll('.pending-message').length, interrupted: Boolean(document.querySelector('[aria-label="Interrupted messages"]')) });
      if (window.frames.length < 60) afterPaint();
    };
    afterPaint();
  });
  await composer.fill('Queued while held');
  await composer.press('Enter');
  await page.waitForFunction(() => window.frames.length >= 60);
  const frames = await page.evaluate(() => window.frames);
  assert.deepEqual(frames.filter(frame => frame.interrupted), [], 'the message being queued is never offered as interrupted');
  const moves = frames.filter((frame, index) => index > 0 && frame.lastBottom !== frames[index - 1].lastBottom);
  assert.equal(moves.length, 1, 'the history moves once: ' + JSON.stringify(frames.map(frame => [frame.lastBottom, frame.queued])));
  assert.ok(moves[0].lastBottom < frames[0].lastBottom, 'the history moves up to stay above the queue');
  assert.equal(moves[0].queued, 1, 'the history moves in the frame where the queue row appears');
});
