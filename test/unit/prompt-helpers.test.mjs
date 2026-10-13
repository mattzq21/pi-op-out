import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAgentValue, decodeAgentValue } from '../../clients/ui/lib/agentProtocol.ts';
import { contextUsageAfterCompaction } from '../../clients/ui/lib/contextUsage.ts';
import { appendTerminalOutput } from '../../clients/ui/lib/terminalOutput.ts';

test('agent values use UTF-8 JSON and unpadded URL-safe base64', () => {
  for (const [value, encoded] of [
    [{ name: 'développeur 🦆', tools: ['中文', '???~~~'] }, 'eyJuYW1lIjoiZMOpdmVsb3BwZXVyIPCfpoYiLCJ0b29scyI6WyLkuK3mlociLCI_Pz9-fn4iXX0'],
    [null, 'bnVsbA'],
    [[1, true, ''], 'WzEsdHJ1ZSwiIl0'],
  ]) {
    assert.equal(encodeAgentValue(value), encoded);
    assert.deepEqual(decodeAgentValue(encoded), value);
  }

  assert.throws(() => decodeAgentValue('!'));
  assert.throws(() => decodeAgentValue('bm90IGpzb24'));
});

test('compaction replaces valid usage estimates and preserves unknown or invalid usage', () => {
  const current = { tokens: 500, contextWindow: 1000, percent: 50, extra: true };
  assert.equal(contextUsageAfterCompaction(undefined, {}), undefined);

  for (const result of [null, {}, { estimatedTokensAfter: -1 }, { estimatedTokensAfter: Infinity }, { estimatedTokensAfter: NaN }, { estimatedTokensAfter: '20' }]) assert.equal(contextUsageAfterCompaction(current, { result }), current);
  assert.deepEqual(contextUsageAfterCompaction(current, { result: { estimatedTokensAfter: 125 } }), { ...current, tokens: 125, percent: 12.5 });
  assert.equal(contextUsageAfterCompaction(current, { result: { estimatedTokensAfter: 0 } }).percent, 0);
  assert.equal(contextUsageAfterCompaction({ ...current, contextWindow: 0 }, { result: { estimatedTokensAfter: 20 } }).percent, null);
  assert.equal(current.tokens, 500);
});



test('terminal history bounds memory while retaining the complete output cursor', () => {
  assert.deepEqual(appendTerminalOutput('abc', 9, 'def'), { output: 'abcdef', outputEnd: 12 });
  const result = appendTerminalOutput('old!' + 'x'.repeat(4_194_300), 100, 'tail', 42);
  assert.equal(result.output.length, 4_194_304);
  assert.equal(result.output, 'x'.repeat(4_194_300) + 'tail');
  assert.equal(result.outputEnd, 142);
  assert.deepEqual(appendTerminalOutput('', 0, '', 0), { output: '', outputEnd: 0 });
});
