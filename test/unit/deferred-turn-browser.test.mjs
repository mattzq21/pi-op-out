import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const open = t => startupPage(t, 'development', { entryPoint: 'test/fixtures/deferred-turn-browser.tsx', ready: '[data-testid="messages"]', holdStorage: false });
const shown = page => page.locator('.turn-text').evaluateAll(nodes => nodes.map(node => Number(node.textContent.match(/\d+/)[0])));

test('old turns are drawn only when the reader scrolls near them, or when they are asked to show', async t => {
  const page = await open(t);
  await page.getByText('Answer number 29').waitFor();
  const first = await shown(page);
  assert.ok(first.includes(27) && first.includes(29), 'the newest turns are drawn');
  assert.ok(!first.includes(0), 'the oldest turn waits');

  await page.locator('[data-response-turn="turn-5"]').evaluate(turn => turn.dispatchEvent(new Event('piop:reveal-turn')));
  await page.getByText('Answer number 5', { exact: true }).waitFor();
  assert.ok(!(await shown(page)).includes(0));

  await page.getByTestId('messages').evaluate(root => { root.scrollTop = 0; });
  await page.getByText('Answer number 0', { exact: true }).waitFor();
});

test('while Find in page is open every turn is drawn, so its text can be found', async t => {
  const page = await open(t);
  await page.getByText('Answer number 29').waitFor();
  assert.ok(!(await shown(page)).includes(1));
  await page.locator('.chat-shell').evaluate(shell => { shell.setAttribute('data-find-open', ''); shell.dispatchEvent(new CustomEvent('piop:find-open', { detail: true })); });
  await page.waitForFunction(() => document.querySelectorAll('.turn-text').length === 30);
  assert.deepEqual(await shown(page), Array.from({ length: 30 }, (_, index) => index));
});
