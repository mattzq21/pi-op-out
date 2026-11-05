import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessage, applyAssistantMessageEvent, branchMessages } from '../../clients/ui/lib/messages.ts';
import { promptContext } from '../prompt-context-fixture.mjs';
import { historyViewSchema } from '../../clients/ui/lib/responseSchemas.ts';

test('message normalization preserves content and selects stable identifiers and roles', () => {
  const content = [{ type: 'text', text: 'hello' }];
  const original = { role: 'user', content, timestamp: 100, id: 'original' };
  assert.deepEqual(normalizeMessage(original, 'entry', '2026-01-01T00:00:00Z', 'fallback'), { ...original, id: 'entry', entryId: 'entry', toolStatus: undefined, completedAt: 1767225600000 });
  assert.equal(normalizeMessage(original, undefined, 'invalid', 'fallback').id, 'fallback');
  assert.equal(normalizeMessage(original).id, 'original');
  const generated = normalizeMessage({ role: 'assistant', timestamp: '100', content: '' });
  assert.equal(typeof generated.id, 'string');
  assert.ok(generated.id.length > 0);
  assert.equal(generated.timestamp, 100);
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

  assert.equal(normalizeMessage({ role: 'custom', customType: 'pi-desktop-mcp-status' }).role, 'system');
  // A plugin's message comes with how to show it, from the plugin's manifest.
  assert.equal(normalizeMessage({ role: 'custom', customType: 'piop-review-link', pluginMessage: { customRole: 'system', contextInjection: false } }).role, 'system');
  assert.equal(normalizeMessage({ role: 'custom', customType: 'piop-review-link' }).role, 'custom');
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

test('streamed tool calls preserve identity without retaining arguments', () => {
  let message = { role: 'assistant', content: '' };
  message = applyAssistantMessageEvent(message, { type: 'toolcall_start', contentIndex: 0, id: 'call', toolName: 'read' });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_delta', contentIndex: 0, delta: '"a"}' });
  assert.deepEqual(message.content[0], { type: 'toolCall', id: 'call', name: 'read', arguments: {}, partialArgs: '' });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_end', contentIndex: 0, toolCall: { arguments: { path: 'a' } } });
  assert.deepEqual(message.content[0], { type: 'toolCall', id: 'call', name: 'read', arguments: {} });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_delta', contentIndex: 0 });
  assert.equal(message.content[0].partialArgs, undefined);
  message = applyAssistantMessageEvent(message, { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'next', name: 'write', arguments: 'invalid' } });
  assert.deepEqual(message.content[1], { type: 'toolCall', id: 'next', name: 'write', arguments: {} });
  message = applyAssistantMessageEvent(message, { type: 'toolcall_start', contentIndex: 2 });
  assert.equal(typeof message.content[2].id, 'string');
  assert.ok(message.content[2].id.length > 0);
  assert.notEqual(message.content[2].id, message.content[0].id);
  assert.notEqual(message.content[2].id, message.content[1].id);
  assert.equal(message.content[2].name, 'tool');
  assert.deepEqual(applyAssistantMessageEvent(message, { type: 'toolcall_end', contentIndex: 2 }).content, message.content);
});


const msg = (id, parentId, role, content = '', extra = {}) => ({ type: 'message', id, parentId, message: { role, content, timestamp: 100, ...extra } });

const custom = (id, parentId, customType, data) => ({ type: 'custom', id, parentId, customType, data });

test('branch reconstruction follows ancestry and attaches context without eager tool inputs', () => {
  const entries = [
    msg('u', null, 'user', 'question'),
    custom('context', 'u', 'pi-desktop-prompt-context', promptContext({ system: 100 })),
    custom('context2', 'context', 'pi-desktop-prompt-context', promptContext({ system: 999 })),
    msg('a', 'context2', 'assistant', [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a' } }]),
    msg('t', 'a', 'toolResult', 'result', { toolCallId: 'call' }),
    msg('final', 't', 'assistant', 'answer'),
    msg('sibling', 'u', 'assistant', 'other branch'),
  ];

  const result = branchMessages(entries, 'final');
  assert.deepEqual(result.map(message => message.id), ['u', 'a', 't', 'final']);
  assert.deepEqual(result[0].promptContext, promptContext({ system: 100 }));
  assert.equal(result[2].toolInput, undefined);
  assert.deepEqual(branchMessages(entries, null), []);
  assert.deepEqual(branchMessages(entries, 'missing'), []);
  assert.deepEqual(branchMessages([msg('cycle', 'cycle', 'user')], 'cycle').map(message => message.id), ['cycle']);
});

test('branch reconstruction handles orphaned metadata and custom visibility', () => {
  const entries = [
    custom('c', null, 'pi-desktop-prompt-context', {}),
    msg('u', 'c', 'user'),
    { id: 's', parentId: 'u', type: 'custom_message', customType: 'piop-review-link', pluginMessage: { customRole: 'system', contextInjection: false } },
    { id: 'hidden', parentId: 's', type: 'custom_message', customType: 'piop-session-operation', display: false },
    msg('unsupported', 'hidden', 'system'),
    msg('t', 'unsupported', 'toolResult', '', { toolCallId: 'unknown' }),
  ];

  const result = branchMessages(entries, 't');
  assert.deepEqual(result.map(message => message.id), ['u', 's', 't']);
  assert.equal(result[1].role, 'system');
  assert.equal(result[1].content, '');
  assert.equal(result[2].toolInput, undefined);
});

test('a plugin message read from a chat history keeps how its host shows it', () => {
  const history = historyViewSchema.parse({ leafId: 'link', entries: [
    { id: 'u', parentId: null, type: 'message', message: { role: 'user', content: 'Review this' } },
    { id: 'link', parentId: 'u', type: 'custom_message', customType: 'piop-review-link', content: 'Code review', display: true, pluginMessage: { customRole: 'system', contextInjection: false } },
  ] });
  const link = branchMessages(history.entries, history.leafId).at(-1);
  assert.equal(link.role, 'system');
  assert.deepEqual(link.pluginMessage, { customRole: 'system', contextInjection: false });
});
