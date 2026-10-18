import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPromptHistoryNavigation } from '../../clients/ui/lib/promptHistory.ts';

const sentPrompts = ['fix the build', 'add a test', 'commit'];

test('up recalls older prompts and down past the newest restores the unsent draft', () => {
  const history = createPromptHistoryNavigation(() => sentPrompts);
  assert.equal(history.move('older', 'half typed', true), 'commit');
  assert.equal(history.move('older', 'commit', true), 'add a test');
  assert.equal(history.move('older', 'add a test', true), 'fix the build');
  assert.equal(history.move('older', 'fix the build', true), 'fix the build');
  assert.equal(history.move('newer', 'fix the build', true), 'add a test');
  assert.equal(history.move('newer', 'add a test', true), 'commit');
  assert.equal(history.move('newer', 'commit', true), 'half typed');
  assert.equal(history.move('newer', 'half typed', true), undefined);
});

test('up below the first line of a draft moves the cursor instead of recalling a prompt', () => {
  const history = createPromptHistoryNavigation(() => sentPrompts);
  assert.equal(history.move('older', 'line one\nline two', false), undefined);
  assert.equal(history.move('newer', 'line one\nline two', true), undefined);
});

test('editing a recalled prompt keeps the edit as the draft to return to', () => {
  const history = createPromptHistoryNavigation(() => sentPrompts);
  history.move('older', '', true);
  history.move('older', 'commit', true);
  assert.equal(history.move('older', 'add a test for parsing', true), 'commit');
  assert.equal(history.move('newer', 'commit', true), 'add a test for parsing');
});

test('blank prompts are skipped and an empty history leaves the arrow keys alone', () => {
  assert.equal(createPromptHistoryNavigation(() => []).move('older', 'draft', true), undefined);
  const history = createPromptHistoryNavigation(() => ['first', '   ', '']);
  assert.equal(history.move('older', '', true), 'first');
});
