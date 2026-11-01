import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientPayload } from '../../daemon/src/host/payload';

const run = { version: 1, name: 'Reader', task: 'Read', status: 'running', sessionId: 'id', sessionPath: '/s.jsonl', hostId: 'local', toolCallId: 'call', look: 3, output: 'long', startedAt: 1 };
const icon = { name: 'Reader', sessionId: 'id', sessionPath: '/s.jsonl', hostId: 'local', toolCallId: 'call', look: 3 };

test('subagent tool results keep a small subagent list after the payload is deferred', () => {
  const message = clientPayload({ role: 'toolResult', toolName: 'spawn_subagents', toolCallId: 'call', content: [{ type: 'text', text: 'x' }], details: { version: 1, runs: [run] } });
  assert.equal(message.details, undefined);
  assert.deepEqual(message.subagents, [icon]);
  const end = clientPayload({ type: 'tool_execution_end', toolName: 'await_subagents', toolCallId: 'call', result: { content: [], details: { runs: [run] } } });
  assert.deepEqual(end.subagents, [icon]);
  assert.equal(clientPayload({ role: 'toolResult', toolName: 'read', details: { runs: [run] } }).subagents, undefined);
});
