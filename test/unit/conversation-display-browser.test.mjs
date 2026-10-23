import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const readTurn = [
  { id: 'question', role: 'user', content: 'Question', timestamp: 0 },
  { id: 'call', role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] },
  { id: 'read-one', role: 'tool', toolName: 'read', content: 'First file contents' },
  { id: 'read-two', role: 'tool', toolName: 'read', content: 'Second file contents' },
  { id: 'answer', role: 'assistant', content: [{ type: 'thinking', thinking: 'Consider the evidence' }, { type: 'text', text: 'Final answer' }], completedAt: 61000 },
];

async function completedConversation(t, messages = readTurn) {
  return startupPage(t, 'development', {
    entryPoint: 'test/fixtures/conversation-display-browser.tsx', ready: 'summary', holdStorage: false,
    prepare: page => page.exposeFunction('conversationMessages', () => messages),
  });
}

test('completed work groups repeated tools and keeps the final answer outside its disclosure', async t => {
  const page = await completedConversation(t);
  const summary = page.locator('summary').filter({ hasText: /^Worked for 1min 1s$/ });
  const group = summary.locator('..');
  assert.equal(await group.evaluate(node => node.open), false);
  await summary.click();
  await group.getByText('Consider the evidence', { exact: true }).waitFor();
  assert.match(await group.textContent(), /read x2/);
  assert.doesNotMatch(await group.textContent(), /Final answer/);
  const answer = page.getByText('Final answer', { exact: true });
  assert.equal(await answer.isVisible(), true);
  assert.equal(await group.getByText('Final answer', { exact: true }).count(), 0);
});

test('debug view exposes each repeated tool result separately', async t => {
  const page = await completedConversation(t);
  const summary = page.locator('summary').filter({ hasText: /^Worked for 1min 1s$/ });
  await summary.click();
  await page.getByText('Consider the evidence', { exact: true }).waitFor();
  await page.getByLabel('Debug view', { exact: true }).check();
  const group = summary.locator('..');
  if (!await group.evaluate(node => node.open)) await summary.click();
  const tools = group.locator('summary').filter({ hasText: /read/ });
  assert.equal(await tools.count(), 2);
  await tools.nth(0).click();
  await group.getByText('First file contents', { exact: true }).waitFor();
  await tools.nth(1).click();
  await group.getByText('Second file contents', { exact: true }).waitFor();
  assert.deepEqual((await group.getByLabel('Tool output', { exact: true }).allTextContents()).sort(), ['First file contents', 'Second file contents']);
  assert.doesNotMatch(await group.textContent(), /read x2/);
});

test('a failed call between repeated tool calls stays visible as a failure', async t => {
  const page = await completedConversation(t, [
    ...readTurn.slice(0, 3),
    { id: 'read-denied', role: 'tool', toolName: 'read', toolStatus: 'error', content: 'Permission denied' },
    ...readTurn.slice(3),
  ]);
  const summary = page.locator('summary').filter({ hasText: /^Worked for 1min 1s$/ });
  await summary.click();
  const group = summary.locator('..');
  await group.getByText('Consider the evidence', { exact: true }).waitFor();
  const failed = group.getByText('Failed', { exact: true });
  assert.equal(await failed.count(), 1);
  assert.equal(await failed.isVisible(), true);
  assert.equal(await group.getByText('Completed', { exact: true }).count(), 2);
  assert.doesNotMatch(await group.textContent(), /read x\d/);
  await page.getByLabel('Debug view', { exact: true }).check();
  if (!await group.evaluate(node => node.open)) await summary.click();
  const failedTool = group.locator('summary').filter({ hasText: 'Failed' });
  await failedTool.click();
  const reason = group.getByLabel('Tool output', { exact: true }).getByText('Permission denied', { exact: true });
  await reason.waitFor();
  assert.equal(await reason.isVisible(), true);
});
