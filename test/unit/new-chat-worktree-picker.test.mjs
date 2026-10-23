import { installDom, renderComponent, act } from '../dom.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NewChatWorktreePicker } from '../../clients/ui/components/NewChatWorktreePicker.tsx';

test('inline worktree picker defaults to the main branch and permits changing branch or returning to main', async t => {
  const dom = installDom();
  const choices = [];
  const view = await renderComponent(NewChatWorktreePicker, { options: { repository: '/repo', branches: ['feature', 'main'], defaultBranch: 'main' }, onChange: value => choices.push(value) });
  t.after(async () => { await view.unmount(); dom.restore(); });
  assert.equal(document.querySelector('dialog'), null);
  const choose = async (label, value) => {
    await act(() => document.querySelector(`[aria-label^="${label}:"]`).click());
    await act(() => document.querySelector(`[role="option"][data-value="${value}"]`).click());
  };
  assert.equal(document.querySelector('[aria-label^="Start from branch:"]'), null);
  await choose('Worktree', 'new');
  assert.equal(document.querySelector('[aria-label="Start from branch: main"]').textContent, 'main');
  assert.deepEqual(choices, ['main']);
  await choose('Start from branch', 'feature');
  assert.deepEqual(choices, ['main', 'feature']);
  await choose('Worktree', 'main');
  assert.equal(choices[2], undefined);
  assert.equal(document.querySelector('[aria-label^="Start from branch:"]'), null);
});
