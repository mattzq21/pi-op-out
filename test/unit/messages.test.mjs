import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileChanges, resumeMarker, isResumeMessage, checkpointLatestUser, cacheHitStats, normalizeMessage, applyAssistantMessageEvent, branchMessages } from '../../src/lib/messages.ts';

test('message normalization preserves content and selects stable identifiers and roles', () => {
  const content = [{ type: 'text', text: 'hello' }];
  const original = { role: 'user', content, timestamp: 100, id: 'original' };
  assert.deepEqual(normalizeMessage(original, 'entry', '2026-01-01T00:00:00Z', 'fallback'), { ...original, id: 'entry', entryId: 'entry', toolStatus: undefined, completedAt: 1767225600000 });
  assert.equal(normalizeMessage(original, undefined, 'invalid', 'fallback').id, 'fallback');
  assert.equal(normalizeMessage(original).id, 'original');
  assert.equal(normalizeMessage({ role: 'assistant', timestamp: '100', content: '' }).id, 'live-assistant-100');
  assert.equal(normalizeMessage({ role: 'user', timestamp: '2026-01-01T00:00:00Z' }).timestamp, 1767225600000);
  const before = Date.now();
  for (const timestamp of [undefined, 'invalid']) {
    const result = normalizeMessage({ role: 'assistant', timestamp });
    assert.ok(result.timestamp >= before && result.timestamp <= Date.now());
    assert.equal(result.completedAt, undefined);
  }
  assert.equal(normalizeMessage({ role: 'toolResult', isError: true }).toolStatus, 'error');
  assert.equal(normalizeMessage({ role: 'toolResult' }).toolStatus, 'done');
  assert.equal(normalizeMessage({ role: 'toolResult' }).role, 'tool');
  for (const customType of ['pi-desktop-mcp-status', 'pi-desktop-catch-up']) assert.equal(normalizeMessage({ role: 'custom', customType }).role, 'system');
  assert.equal(normalizeMessage({ role: 'custom', customType: 'pi-desktop-btw' }).role, 'assistant');
  assert.equal(normalizeMessage({ role: 'custom', customType: 'other' }).role, 'custom');
  assert.equal(original.id, 'original');
});

test('streamed text and reasoning build immutable content and accept final replacements', () => {
  const original = { id: 'a', role: 'assistant', content: 'existing' };
  let message = applyAssistantMessageEvent(original, { type: 'text_delta', contentIndex: 0, delta: ' text' });
  assert.deepEqual(message.content, [{ type: 'text', text: 'existing text' }]);
  assert.equal(message.streaming, true);
  assert.equal(original.content, 'existing');
  for (const [type, property] of [['text', 'text'], ['thinking', 'thinking']]) {
    message = applyAssistantMessageEvent(message, { type: `${type}_start`, contentIndex: 2 });
    assert.deepEqual(message.content[2], { type, [property]: '' });
    message = applyAssistantMessageEvent(message, { type: `${type}_delta`, contentIndex: 2, delta: 'first' });
    message = applyAssistantMessageEvent(message, { type: `${type}_delta`, contentIndex: 2, delta: ' second' });
    assert.deepEqual(message.content[2], { type, [property]: 'first second' });
    message = applyAssistantMessageEvent(message, { type: `${type}_delta`, contentIndex: 2 });
    assert.equal(message.content[2][property], 'first second');
    message = applyAssistantMessageEvent(message, { type: `${type}_end`, contentIndex: 2, content: 'final' });
    assert.deepEqual(message.content[2], { type, [property]: 'final' });
    message = applyAssistantMessageEvent(message, { type: `${type}_end`, contentIndex: 2 });
    assert.equal(message.content[2][property], '');
  }
  assert.deepEqual(message.content[1], { type: 'text', text: '' });
  assert.deepEqual(applyAssistantMessageEvent({ ...original, content: [] }, { type: 'thinking_delta', contentIndex: 0, delta: 'reason' }).content, [{ type: 'thinking', thinking: 'reason' }]);
  assert.deepEqual(applyAssistantMessageEvent({ ...original, content: [{ type: 'thinking', thinking: 'private' }] }, { type: 'text_delta', contentIndex: 0, delta: 'public' }).content, [{ type: 'text', text: 'public' }]);
  for (const contentIndex of [undefined, -1, 0.5, '0', NaN]) assert.equal(applyAssistantMessageEvent(original, { type: 'text_start', contentIndex }), original);
});

test('streamed tool calls preserve identity and replace partial JSON with parsed arguments', () => {
  let message = { role: 'assistant', content: '' };
  message = applyAssistantMessageEvent(message, { type: 'toolcall_start', contentIndex: 0, id: 'call', toolName: 'read' });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_delta', contentIndex: 0, delta: '"a"}' });
  assert.deepEqual(message.content[0], { type: 'toolCall', id: 'call', name: 'read', arguments: {}, partialArgs: '{"path":"a"}' });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_end', contentIndex: 0, toolCall: { arguments: { path: 'a' } } });
  assert.deepEqual(message.content[0], { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a' } });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_delta', contentIndex: 0 });
  assert.equal(message.content[0].partialArgs, '');
  message = applyAssistantMessageEvent(message, { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'next', name: 'write', arguments: 'invalid' } });
  assert.deepEqual(message.content[1], { type: 'toolCall', id: 'next', name: 'write', arguments: {} });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_start', contentIndex: 2 });
  assert.equal(message.content[2].id, 'tool-2');
  assert.equal(message.content[2].name, 'tool');
  assert.deepEqual(applyAssistantMessageEvent(message, { type: 'toolcall_end', contentIndex: 2 }).content, message.content);
});

test('file-change snapshots attach to the last matching tool and sanitize extension data', () => {
  const mapping = { toolCallId: 'call', path: 'a', absolutePath: '/repo/a', canonicalPath: '/repo/a' };
  const data = { cwd: '/repo', patch: 'patch', toolCallIds: ['call', 42], paths: ['a', null], warnings: ['warning', 1], toolPaths: [null, {}, mapping] };
  const entry = { id: 'snapshot', type: 'custom', customType: 'piop-file-changes', data };
  const messages = [{ id: 'call', role: 'tool' }, { id: 'answer', role: 'assistant' }, { id: 'result', role: 'tool', toolCallId: 'call', fileChanges: [{ id: 'keep' }, { id: 'snapshot', patch: 'old' }] }, { id: 'tail', role: 'assistant' }];
  const result = appendFileChanges(messages, entry);
  assert.equal(result[0], messages[0]);
  assert.equal(result[3], messages[3]);
  assert.deepEqual(result[2].fileChanges, [{ id: 'keep' }, { id: 'snapshot', ...data, toolCallIds: ['call'], paths: ['a'], warnings: ['warning'], toolPaths: [mapping] }]);
  assert.equal(messages[2].fileChanges[1].patch, 'old');
  assert.equal(appendFileChanges(messages, { ...entry, type: 'message' }), messages);
  assert.equal(appendFileChanges(messages, { ...entry, customType: 'other' }), messages);
  for (const invalid of [undefined, {}, { ...data, cwd: null }, { ...data, patch: null }, { ...data, toolCallIds: null }, { ...data, paths: null }, { ...data, toolCallIds: [] }]) assert.equal(appendFileChanges(messages, { ...entry, data: invalid }), messages);
  const minimal = appendFileChanges([messages[0]], { ...entry, data: { ...data, warnings: undefined, toolPaths: undefined } });
  assert.deepEqual(minimal[0].fileChanges[0].warnings, []);
  assert.deepEqual(minimal[0].fileChanges[0].toolPaths, []);
});

test('resume markers and checkpoints distinguish synthetic prompts from ordinary messages', () => {
  const marker = { type: 'custom', customType: 'pi-desktop-resume', data: { message: 'resume\nnow' } };
  assert.equal(resumeMarker(marker), 'resume\nnow');
  for (const entry of [{}, { ...marker, type: 'message' }, { ...marker, customType: 'other' }, { ...marker, data: { message: 1 } }]) assert.equal(resumeMarker(entry), undefined);
  const markers = new Set(['resume\nnow']);
  assert.equal(isResumeMessage({ role: 'user', content: 'resume\nnow' }, markers), true);
  assert.equal(isResumeMessage({ role: 'user', content: [{ type: 'text', text: 'resume' }, { type: 'image' }, { type: 'text', text: 'now' }] }, markers), true);
  assert.equal(isResumeMessage({ role: 'assistant', content: 'resume\nnow' }, markers), false);
  assert.equal(isResumeMessage({ role: 'user' }, markers), false);
  const messages = [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }];
  const result = checkpointLatestUser(messages);
  assert.equal(result[0], messages[0]);
  assert.equal(result[2].contextCheckpoint, true);
  assert.equal(messages[2].contextCheckpoint, undefined);
  assert.equal(checkpointLatestUser(result), result);
  const empty = [];
  assert.equal(checkpointLatestUser(empty), empty);
});

test('cache statistics include writes and enforce both relative and absolute hit thresholds', () => {
  assert.equal(cacheHitStats(), undefined);
  assert.equal(cacheHitStats({ input: 0, cacheRead: 0 }), undefined);
  assert.deepEqual(cacheHitStats({ input: 1000, cacheRead: 1000 }), { rate: 50, low: false, cachedTokens: 1000, promptTokens: 2000 });
  assert.deepEqual(cacheHitStats({ input: 0, cacheRead: 999 }), { rate: 100, low: true, cachedTokens: 999, promptTokens: 999 });
  assert.deepEqual(cacheHitStats({ input: 1000, cacheRead: 1000, cacheWrite: 1000 }), { rate: 33, low: true, cachedTokens: 1000, promptTokens: 3000 });
});

const msg = (id, parentId, role, content = '', extra = {}) => ({ type: 'message', id, parentId, message: { role, content, timestamp: 100, ...extra } });
const custom = (id, parentId, customType, data) => ({ type: 'custom', id, parentId, customType, data });
test('branch reconstruction follows ancestry, hides resume prompts and attaches tool inputs and context', () => {
  const entries = [
    msg('u', null, 'user', 'question'),
    custom('context', 'u', 'pi-desktop-prompt-context', { tokens: 100 }),
    custom('context2', 'context', 'pi-desktop-prompt-context', { tokens: 999 }),
    msg('a', 'context2', 'assistant', [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a' } }]),
    msg('t', 'a', 'toolResult', 'result', { toolCallId: 'call' }),
    custom('files', 't', 'piop-file-changes', { cwd: '/repo', patch: '', paths: ['a'], toolCallIds: ['call'] }),
    custom('r', 'files', 'pi-desktop-resume', { message: 'resume' }),
    msg('synthetic', 'r', 'user', 'resume'),
    msg('final', 'synthetic', 'assistant', 'answer'),
    msg('sibling', 'u', 'assistant', 'other branch'),
  ];
  const result = branchMessages(entries, 'final');
  assert.deepEqual(result.map(message => message.id), ['u', 'a', 't', 'final']);
  assert.deepEqual(result[0].promptContext, { tokens: 100 });
  assert.equal(result[0].contextCheckpoint, true);
  assert.deepEqual(result[2].toolInput, { path: 'a' });
  assert.equal(result[2].fileChanges[0].id, 'files');
  assert.equal(entries[0].message.contextCheckpoint, undefined);
  assert.deepEqual(branchMessages(entries, null), []);
  assert.deepEqual(branchMessages(entries, 'missing'), []);
  assert.deepEqual(branchMessages([msg('cycle', 'cycle', 'user')], 'cycle').map(message => message.id), ['cycle']);
});

test('branch reconstruction handles orphaned metadata, custom visibility and pauses', () => {
  const entries = [
    custom('c', null, 'pi-desktop-prompt-context', {}),
    msg('u', 'c', 'user'),
    custom('p', 'u', 'pi-desktop-pause-state', { isPaused: true }),
    { id: 's', parentId: 'p', type: 'custom_message', customType: 'pi-desktop-catch-up' },
    { id: 'hidden', parentId: 's', type: 'custom_message', display: false },
    { id: 'btw', parentId: 'hidden', type: 'custom_message', customType: 'pi-desktop-btw' },
    msg('unsupported', 'btw', 'system'),
    msg('t', 'unsupported', 'toolResult', '', { toolCallId: 'unknown' }),
    custom('unpaused', 't', 'pi-desktop-pause-state', { isPaused: false }),
  ];
  const result = branchMessages(entries, 'unpaused');
  assert.deepEqual(result.map(message => message.id), ['u', 's', 't']);
  assert.equal(result[0].contextCheckpoint, true);
  assert.equal(result[1].role, 'system');
  assert.equal(result[1].content, '');
  assert.equal(result[2].toolInput, undefined);
});
