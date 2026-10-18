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

test('a growing streaming answer keeps its newest line in view until the reader scrolls up', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/chat-scroll-browser.tsx', ready: '.messages' });
  const messages = page.locator('.messages');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const inView = text => page.getByText(text, { exact: true }).evaluate(line => {
    const box = line.getBoundingClientRect();
    const view = line.closest('.messages').getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  });
  const waitUntilVisible = text => page.getByText(text, { exact: true }).evaluate(line => new Promise((resolve, reject) => {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.target === line && entry.isIntersecting && entry.intersectionRatio === 1)) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    }, { root: line.closest('.messages'), threshold: 1 });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`${line.textContent} did not become fully visible within 5 seconds`));
    }, 5000);
    observer.observe(line);
  }));
  await frames();
  for (let index = 1; index <= 12; index++) {
    await page.evaluate(line => window.streamAnswerLine(line), `Streamed line ${index}`);
    await waitUntilVisible(`Streamed line ${index}`);
    assert.ok(await inView(`Streamed line ${index}`), `streamed line ${index} is visible as it arrives`);
  }
  await messages.hover();
  const scrolled = messages.evaluate(element => new Promise(resolve => element.addEventListener('scroll', resolve, { once: true })));
  await page.mouse.wheel(0, -250);
  await scrolled;
  await frames();
  const position = await messages.evaluate(element => element.scrollTop);
  await page.evaluate(() => window.streamAnswerLine('Streamed line 13'));
  await frames();
  assert.ok(Math.abs(await messages.evaluate(element => element.scrollTop) - position) <= 2, 'the answer grows without moving the reader');
  assert.equal(await inView('Streamed line 13'), false, 'the reader stays in earlier text');
});
