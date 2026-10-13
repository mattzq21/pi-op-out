import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('scrolling upward stops following new messages until the reader returns to the bottom', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/chat-scroll-browser.tsx', ready: '.messages' });
  const messages = page.locator('.messages');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const gap = () => messages.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await frames();
  assert.ok(await gap() <= 2);
  await page.evaluate(() => window.appendScrollMessage());
  await frames();
  assert.ok(await gap() <= 2, 'new messages stay in view at the bottom');
  await messages.hover();
  const scrolled = messages.evaluate(element => new Promise(resolve => element.addEventListener('scroll', resolve, { once: true })));
  await page.mouse.wheel(0, -250);
  await scrolled;
  await frames();
  assert.ok(await gap() > 100, 'the reader can move into earlier history');
  const position = await messages.evaluate(element => element.scrollTop);
  await page.evaluate(() => window.appendScrollMessage());
  await frames();
  assert.ok(Math.abs(await messages.evaluate(element => element.scrollTop) - position) <= 2, 'new output does not move the reader');
  await messages.evaluate(element => new Promise(resolve => {
    element.addEventListener('scroll', resolve, { once: true });
    element.scrollTop = element.scrollHeight;
  }));
  await frames();
  await page.evaluate(() => window.appendScrollMessage());
  await frames();
  assert.ok(await gap() <= 2, 'following resumes at the bottom');
});
