import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textOf, thinkingOf, uid } from '../../src/lib/content.ts';
import { encodeAgentValue, decodeAgentValue } from '../../src/lib/agentProtocol.ts';
import { contextUsageAfterCompaction } from '../../src/lib/contextUsage.ts';
import { dictionaryMatches, applyDictionary } from '../../src/lib/dictionaries.ts';
import { parseHookStats, messageHookCounts } from '../../src/lib/hookStats.ts';
import { findReplaceableAbortedTurn } from '../../src/lib/abortedTurn.ts';
import { appendTerminalOutput, TERMINAL_OUTPUT_LIMIT } from '../../src/lib/terminalOutput.ts';
import { matchesShortcut, shortcutFromEvent } from '../../src/lib/keybindings.ts';

test('content helpers separate visible text, reasoning and attachments', () => {
  const content = [{ type: 'text', text: 'Hello' }, { type: 'thinking', thinking: 'First' }, { type: 'image', data: 'abc' }, { type: 'text', text: ' world' }, { type: 'thinking', thinking: 'Second' }];
  assert.equal(textOf(content), 'Hello world');
  assert.equal(thinkingOf(content), 'First\n\nSecond');
  assert.equal(textOf('plain'), 'plain');
  assert.equal(thinkingOf('plain'), '');
  assert.equal(textOf([]), '');
  assert.match(uid(), /^id-[\da-f-]{36}$/);
  assert.match(uid('message'), /^message-[\da-f-]{36}$/);
  assert.notEqual(uid(), uid());
});

test('agent values round-trip Unicode and use unpadded URL-safe base64', () => {
  for (const value of [{ name: 'développeur 🦆', tools: ['中文', '???~~~'] }, null, [1, true, '']]) {
    const encoded = encodeAgentValue(value);
    assert.match(encoded, /^[\w-]+$/);
    assert.deepEqual(decodeAgentValue(encoded), value);
  }
  assert.throws(() => decodeAgentValue('!'));
  assert.throws(() => decodeAgentValue(btoa('not json')));
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

const dictionaries = [{ entries: [{ word: ' cat ', replacement: ' dog ' }, { word: 'cat food', replacement: 'kibble' }, { word: 'C++', replacement: 'Rust' }, { word: '', replacement: 'empty' }, { word: 'skip', replacement: ' ' }] }, { entries: [{ word: 'cat', replacement: 'wrong' }] }];
test('dictionary expansion respects boundaries, longest phrases, escaping and first-definition priority', () => {
  const input = 'cat food, cat! C++ concatenate cat2 _cat écat caté Cat skip';
  assert.equal(applyDictionary(input, dictionaries), 'kibble, dog! Rust concatenate cat2 _cat écat caté Cat skip');
  assert.deepEqual(dictionaryMatches('cat cat', dictionaries, 1), [{ start: 0, end: 3, replacement: 'dog' }]);
  assert.deepEqual(dictionaryMatches('cat'), []);
  assert.equal(applyDictionary('cat'), 'cat');
  assert.equal(applyDictionary('cat', [{ entries: [{ word: 'cat', replacement: 'cat cat' }] }]), 'cat cat');
});

test('hook statistics reject corrupt data and aggregate each user timestamp once', () => {
  const stats = { other: { completed: 2, failed: 1 }, messages: { 10: { completed: 3, failed: 1 }, 20: { completed: 4, failed: 0 } } };
  assert.deepEqual(parseHookStats(`json:${JSON.stringify(stats)}`), stats);
  for (const value of [undefined, '', 'plain', 'json:{', 'json:null', 'json:{}']) assert.equal(parseHookStats(value), undefined);
  for (const counts of [null, { completed: 1, failed: 2 }, { completed: 1, failed: -1 }, { completed: 1.5, failed: 0 }, { completed: '2', failed: 0 }]) assert.equal(parseHookStats(`json:${JSON.stringify({ ...stats, other: counts })}`), undefined);
  for (const messages of [null, [], { 10: { completed: 0, failed: 1 } }]) assert.equal(parseHookStats(`json:${JSON.stringify({ ...stats, messages })}`), undefined);
  assert.deepEqual(messageHookCounts([{ role: 'user', timestamp: 10 }, { role: 'user', timestamp: 10 }, { role: 'assistant', timestamp: 20 }, { role: 'user', timestamp: 20 }, { role: 'user', timestamp: 30 }], stats), { completed: 7, failed: 1 });
  assert.equal(messageHookCounts([], stats), undefined);
  assert.equal(messageHookCounts([]), undefined);
});

test('retry only replaces an aborted turn after a nonempty user prompt and no checkpoint', () => {
  const user = { role: 'user', content: '  retry me  ' };
  const assistant = { role: 'assistant', stopReason: 'aborted' };
  assert.deepEqual(findReplaceableAbortedTurn([user, { role: 'tool' }, assistant]), { user, assistant, prompt: 'retry me' });
  for (const messages of [[], [user], [assistant], [user, { ...assistant, stopReason: 'stop' }], [user, { ...assistant, errorMessage: 'Response paused' }], [{ ...user, contextCheckpoint: true }, assistant], [{ ...user, content: ' ' }, assistant], [user, { ...assistant, errorMessage: 'Response paused' }, assistant]]) assert.equal(findReplaceableAbortedTurn(messages), undefined);
});

test('terminal history bounds memory while retaining the complete output cursor', () => {
  assert.deepEqual(appendTerminalOutput('abc', 9, 'def'), { output: 'abcdef', outputEnd: 12 });
  const result = appendTerminalOutput('x'.repeat(TERMINAL_OUTPUT_LIMIT), 100, 'tail', 42);
  assert.equal(result.output.length, TERMINAL_OUTPUT_LIMIT);
  assert.ok(result.output.endsWith('tail'));
  assert.equal(result.outputEnd, 142);
  assert.deepEqual(appendTerminalOutput('', 0, '', 0), { output: '', outputEnd: 0 });
});

const keyEvent = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
test('shortcut recording excludes normal typing and preserves all modifiers', () => {
  for (const key of ['Meta', 'Control', 'Alt', 'Shift', 'Tab', 'Escape', 'a', '🦆']) assert.equal(shortcutFromEvent(keyEvent(key)), null);
  assert.equal(shortcutFromEvent(keyEvent('a', { shiftKey: true })), null);
  assert.equal(shortcutFromEvent(keyEvent(' ', { ctrlKey: true })), 'Ctrl+Space');
  assert.equal(shortcutFromEvent(keyEvent('n', { ctrlKey: true, metaKey: true, altKey: true, shiftKey: true })), 'Ctrl+Meta+Alt+Shift+N');
  assert.equal(shortcutFromEvent(keyEvent('F2')), 'F2');
  assert.equal(shortcutFromEvent(keyEvent('Tab', { altKey: true })), 'Alt+Tab');
});

test('shortcut matching supports Mod on either platform and rejects extra modifiers', () => {
  assert.ok(matchesShortcut(keyEvent('n', { ctrlKey: true }), ' Ctrl + n '));
  assert.ok(matchesShortcut(keyEvent('n', { metaKey: true }), 'Mod+N'));
  assert.ok(matchesShortcut(keyEvent('n', { ctrlKey: true }), 'Mod+N'));
  assert.ok(matchesShortcut(keyEvent(' ', { altKey: true }), 'Alt+Space'));
  assert.equal(matchesShortcut(keyEvent('F2'), 'F2'), false);
  for (const shortcut of ['', '+', 'Ctrl', 'N', 'Shift+N', 'Alt+N', 'Meta+N', 'Ctrl+Shift+N', 'Ctrl+B']) assert.equal(matchesShortcut(keyEvent('n', { ctrlKey: true }), shortcut), false);
  assert.equal(matchesShortcut(keyEvent('n'), 'Mod+N'), false);
  assert.equal(matchesShortcut(keyEvent('n', { ctrlKey: true, altKey: true }), 'Ctrl+N'), false);
});
