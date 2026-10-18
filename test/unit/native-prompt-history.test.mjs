import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

test('the desktop command retains a submitted prompt for later reads', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('sync_prompt_history', { entries: [{ id: 'first-prompt', prompt: 'Explain this code' }], legacy: [] });
  assert.deepEqual(await native.invoke('sync_prompt_history', { entries: [], legacy: [] }), ['Explain this code']);
});

test('history keeps each sent prompt once, skips blank ones and keeps the newest 100', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  const sync = (entries, legacy = []) => native.invoke('sync_prompt_history', { entries, legacy });
  await sync([{ id: 'a', prompt: 'fix it' }, { id: 'blank', prompt: '  ' }, { id: 'b', prompt: 'fix it' }]);
  assert.deepEqual(await sync([{ id: 'a', prompt: 'fix it' }, { id: 'c', prompt: 'test it' }]), ['fix it', 'test it'], 'a resent prompt is not added again');
  const many = Array.from({ length: 105 }, (_, index) => ({ id: 'n' + index, prompt: 'prompt ' + index }));
  const history = await sync(many);
  assert.equal(history.length, 100);
  assert.deepEqual([history[0], history.at(-1)], ['prompt 5', 'prompt 104']);
});

test('prompts saved by an older version are imported only into an empty history', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  const sync = (entries, legacy = []) => native.invoke('sync_prompt_history', { entries, legacy });
  assert.deepEqual(await sync([{ id: 'new', prompt: 'newest' }], ['oldest', 'older']), ['oldest', 'older', 'newest']);
  assert.deepEqual(await sync([], ['oldest', 'older', 'stale copy']), ['oldest', 'older', 'newest']);
});
