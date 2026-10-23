import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const open = t => startupPage(t, 'development', { entryPoint: 'test/fixtures/response-navigator-browser.tsx', ready: '[data-testid="messages"]', holdStorage: false });
const current = page => page.locator('.response-navigator-marker[aria-current="location"]').getAttribute('aria-label');
/** How far the answer's top is below the top of the scrolling chat. */
const answerOffset = (page, id) => page.evaluate(id => document.querySelector(`[data-response-id="${id}"]`).getBoundingClientRect().top - document.querySelector('[data-testid="messages"]').getBoundingClientRect().top, id);

test('the response rail jumps to an answer, marks where the reader is, and follows scrolling', async t => {
  const page = await open(t);
  const rail = page.getByRole('navigation', { name: 'Agent responses' });
  await rail.waitFor();
  assert.equal(await page.locator('.response-navigator-marker').count(), 3);
  assert.equal(await current(page), 'Go to agent response 1: Plan the parser');

  await page.getByRole('button', { name: 'Go to agent response 2: Write the lexer' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.getAttribute('aria-label')?.startsWith('Go to agent response 2'));
  assert.ok(Math.abs(await answerOffset(page, 'answer-1') - 24) <= 1, 'the answer sits just below the top');
  assert.ok(await page.evaluate(() => window.navigated) > 0, 'the chat stops following the newest answer');

  await page.getByTestId('messages').evaluate(root => { root.scrollTop = root.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.getAttribute('aria-label')?.startsWith('Go to agent response 3'));
  await page.getByTestId('messages').evaluate(root => { root.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.getAttribute('aria-label')?.startsWith('Go to agent response 1'));
});

test('the response rail shows only for two or more answers in a chat that scrolls', async t => {
  const page = await open(t);
  await page.getByRole('navigation', { name: 'Agent responses' }).waitFor();
  await page.evaluate(() => window.setAnswers(1));
  await page.getByRole('navigation', { name: 'Agent responses' }).waitFor({ state: 'detached' });
  await page.evaluate(() => window.setAnswers(3));
  await page.getByRole('navigation', { name: 'Agent responses' }).waitFor();
  await page.getByTestId('messages').evaluate(root => { root.style.height = '5000px'; });
  await page.getByRole('navigation', { name: 'Agent responses' }).waitFor({ state: 'detached' });
});
