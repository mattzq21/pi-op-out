import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPromptHistoryNavigation } from '../../clients/ui/lib/promptHistory.ts';

const sentPrompts = ['fix the build', 'add a test', 'commit'];

test('up in an empty composer recalls older prompts and down past the newest empties it again', () => {
  const history = createPromptHistoryNavigation(() => sentPrompts);
  assert.equal(history.move('older', ''), 'commit');
  assert.equal(history.move('older', 'commit'), 'add a test');
  assert.equal(history.move('older', 'add a test'), 'fix the build');
  assert.equal(history.move('older', 'fix the build'), 'fix the build');
  assert.equal(history.move('newer', 'fix the build'), 'add a test');
  assert.equal(history.move('newer', 'add a test'), 'commit');
  assert.equal(history.move('newer', 'commit'), '');
  assert.equal(history.move('newer', ''), undefined);
});

test('up in a composer with text does nothing', () => {
  const history = createPromptHistoryNavigation(() => sentPrompts);
  assert.equal(history.move('older', 'half typed'), undefined);
});

test('editing a recalled prompt ends the navigation', () => {
  const history = createPromptHistoryNavigation(() => sentPrompts);
  assert.equal(history.move('older', ''), 'commit');
  assert.equal(history.move('older', 'commit!'), undefined);
});

test('a conversation without prompts recalls nothing and blank prompts are skipped', () => {
  assert.equal(createPromptHistoryNavigation(() => []).move('older', ''), undefined);
  const history = createPromptHistoryNavigation(() => ['first', '   ', '']);
  assert.equal(history.move('older', ''), 'first');
  assert.equal(history.move('older', 'first'), 'first');
});
