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

test('the arrow above the composer appears away from the latest message and jumps back to it', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/chat-jump-browser.tsx', ready: '.messages' });
  const messages = page.locator('.messages');
  const jump = page.getByRole('button', { name: 'Scroll to latest', exact: true });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const gap = () => messages.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await frames();
  assert.equal(await jump.count(), 0, 'no arrow at the bottom');
  await messages.hover();
  await page.mouse.wheel(0, -400);
  await frames();
  await jump.waitFor();
  await page.evaluate(() => window.setStreaming(true));
  await frames();
  assert.equal(await jump.count(), 0, 'the working dots are the only jump button while the agent answers');
  await page.evaluate(() => window.setStreaming(false));
  await jump.waitFor();
  await jump.click();
  await frames();
  assert.ok(await gap() <= 2, 'the arrow scrolls to the latest message');
  assert.equal(await jump.count(), 0, 'the arrow hides at the bottom');
  await page.evaluate(() => window.appendMessage());
  await frames();
  assert.ok(await gap() <= 2, 'new messages are followed again');
});

test('selecting text at the latest message keeps the content in place while the hidden turns are drawn', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/chat-scroll-browser.tsx', ready: '.messages' });
  // The desktop engine (WebKitGTK) does not keep the content in place when the height above it changes.
  await page.addStyleTag({ content: '.messages { overflow-anchor: none; }' });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { for (let index = 0; index < 20; index++) window.appendScrollTurn(); });
  await frames();
  for (let jump = 0; jump < 3; jump++) {
    await page.locator('.messages').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await frames();
  }
  const moved = await page.evaluate(() => new Promise(resolve => {
    const view = document.querySelector('.messages').getBoundingClientRect();
    const turn = document.elementFromPoint(view.left + view.width / 2, view.top + view.height / 2).closest('.deferred-turn');
    const top = turn.getBoundingClientRect().top;
    // Listeners run in order, so this one measures after the view handled the selection and before the next frame is drawn.
    document.addEventListener('selectionchange', () => resolve(turn.getBoundingClientRect().top - top), { once: true });
    const range = document.createRange();
    range.selectNodeContents(turn);
    document.getSelection().addRange(range);
  }));
  assert.ok(await page.locator('.chat-shell[data-text-selected]').count(), 'the selection draws the hidden turns');
  assert.ok(Math.abs(moved) <= 1, `the selected turn moved by ${moved}px`);
});

