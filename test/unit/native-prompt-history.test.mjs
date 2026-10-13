import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

test('the desktop command retains a submitted prompt for later reads', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('sync_prompt_history', { entries: [{ id: 'first-prompt', prompt: 'Explain this code' }], legacy: [] });
  assert.deepEqual(await native.invoke('sync_prompt_history', { entries: [], legacy: [] }), ['Explain this code']);
});
