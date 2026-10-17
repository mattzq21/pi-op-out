import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

const sync = (native, entries) => native.invoke('sync_prompt_history', { entries, legacy: [] });

test('the desktop command retains a submitted prompt for later reads', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('sync_prompt_history', { entries: [{ id: 'first-prompt', prompt: 'Explain this code' }], legacy: [] });
  assert.deepEqual(await native.invoke('sync_prompt_history', { entries: [], legacy: [] }), ['Explain this code']);
});

test('a retried submission keeps its original place in history', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await sync(native, [{ id: 'explain-submission', prompt: 'Explain this code' }]);
  await sync(native, [{ id: 'tests-submission', prompt: 'Run the tests' }]);
  assert.deepEqual(await sync(native, [{ id: 'explain-submission', prompt: 'Explain this code' }]), ['Explain this code', 'Run the tests']);
});

test('the same prompt synced by two windows, one after the other, appears once', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await sync(native, [{ id: 'left-window-tests', prompt: 'Run the tests' }]);
  assert.deepEqual(await sync(native, [{ id: 'right-window-tests', prompt: 'Run the tests' }]), ['Run the tests']);
});

test('history keeps only the 100 most recent submissions', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  for (let index = 1; index <= 101; index++) await sync(native, [{ id: `prompt-${index}`, prompt: `Prompt ${index}` }]);
  const history = await sync(native, []);
  assert.deepEqual([history.length, history[0], history.at(-1)], [100, 'Prompt 2', 'Prompt 101']);
});

test('blank submissions are left out while a multiline prompt keeps its exact spacing', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await sync(native, [
    { id: 'spaces-only', prompt: '   ' },
    { id: 'multiline-explain', prompt: '  Explain this code\n\tthen run the tests  \n' },
    { id: 'newlines-and-tabs', prompt: '\n\t\n' },
  ]);
  assert.deepEqual(await sync(native, []), ['  Explain this code\n\tthen run the tests  \n']);
});

test('browser history is imported once, before the first new submission', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('sync_prompt_history', { entries: [{ id: 'new-window-tests', prompt: 'Run the tests' }], legacy: ['Explain this code', 'Fix the build'] });
  const history = await native.invoke('sync_prompt_history', { entries: [{ id: 'stale-window-lint', prompt: 'Run the linter' }], legacy: ['Stale first', 'Stale second', 'Stale third'] });
  assert.deepEqual(history, ['Explain this code', 'Fix the build', 'Run the tests', 'Run the linter']);
});
