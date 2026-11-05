import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook, act } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { recentHistory } from '../../daemon/src/host/views/history_window.ts';

const state = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', messageCount: 0, pendingMessageCount: 0 };
const user = { role: 'user', content: 'Bring me a screenshot', timestamp: 100 };
const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }], stopReason: 'toolUse', timestamp: 101 };
const result = { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: 'File', timestamp: 102 };
const answer = { role: 'assistant', content: [{ type: 'text', text: 'Here it is' }], stopReason: 'stop', timestamp: 103 };
const next = { role: 'user', content: 'Bit darker', timestamp: 104 };

test('work that the client streamed stays when a refresh sends the turn without its work', async t => {
  const dom = installDom();
  const entries = [user, call, result, answer, next].map((message, index) => ({ type: 'message', id: 'e' + index, parentId: index ? 'e' + (index - 1) : null, message }));
  const history = recentHistory({ entries, leafId: 'e4' }, true);
  const snapshot = { revision: 'snapshot', state, history, sequence: 10, epoch: 'epoch', liveTools: [], queue: { type: 'queue_state', pendingMessages: [] } };
  const responses = new Map([['get_session_revision', { revision: 'changed' }], ['get_snapshot', snapshot], ['get_commands', { commands: [] }], ['get_available_models', { models: [] }], ['get_available_thinking_levels', { levels: ['off'] }], ['get_session_stats', {}], ['get_state', { sessionId: 'session', messageCount: 5 }]]);
  const transport = { subscribe() { return () => {}; }, async command(command) { return responses.get(command.type); } };
  const hook = await renderHook(value => useChatSession(value), transport);
  t.after(async () => { await hook.unmount(); dom.restore(); });
  const send = events => act(async () => { events.forEach(event => hook.current.handleEvent(event)); });
  for (const message of [user, call, result, answer]) await send([{ type: 'message_start', message }, { type: 'message_end', message }]);
  await dom.flushFrames();
  assert.ok(hook.current.messages.some(message => message.role === 'tool'), 'the streamed work shows');

  await act(() => hook.current.refresh()); await dom.flushFrames();
  const final = hook.current.messages.find(message => message.role === 'assistant' && message.stopReason === 'stop');
  assert.equal(final.deferredWork, undefined, 'the loaded work is not replaced by a note to load it again');
  assert.ok(hook.current.messages.some(message => message.role === 'tool'), 'the streamed work still shows');
});

test('an open work group loads its work again when a refresh leaves it out', async t => {
  const { createRoot } = await import('solid-js');
  const { renderComponent } = await import('../dom.mjs');
  const { ChatView } = await import('../../clients/ui/components/ChatView.tsx');
  const { useSessionMemory } = await import('../../clients/ui/lib/sessionMemory.ts');
  const dom = installDom();
  const work = { before: null, entries: [{ type: 'message', id: 'call', parentId: null, message: call }, { type: 'message', id: 'result', parentId: 'call', message: result }, { type: 'message', id: 'answer', parentId: 'result', message: answer }], leafId: 'answer' };
  const requests = [];
  const transport = { connected: true, isConnected: () => true, subscribe: () => () => {}, currentHostId: () => 'local', currentCwd: () => '/tmp', ownsConversation: () => true, hasSentMessage: () => true,
    command: async command => { requests.push(command.type); return command.type === 'get_turn_work' ? work : {}; } };
  const deferred = () => [{ id: 'prompt', entryId: 'prompt', ...user }, { id: 'answer', entryId: 'answer', ...answer, deferredWork: { reasoningOnly: false } }];
  let dispose;
  const memory = createRoot(stop => { dispose = stop; const value = useSessionMemory(() => transport, () => state); value.setMessages(deferred()); return value; });
  const view = await renderComponent(ChatView, { readOnly: true, transport, state, get messages() { return memory.messages; }, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} });
  t.after(async () => { await view.unmount(); dispose(); dom.restore(); });
  const settle = async () => { for (let index = 0; index < 3; index++) await dom.flushFrames(); };
  await settle();
  await act(() => { const group = document.querySelector('.work-group'); group.open = true; group.dispatchEvent(new Event('toggle')); });
  await settle();
  assert.ok(!document.querySelector('.work-group-content').textContent.includes('Loading work'), 'the work shows');
  await act(() => memory.setMessages(deferred()));
  await settle();
  assert.equal(requests.filter(type => type === 'get_turn_work').length, 2);
  assert.ok(!document.querySelector('.work-group-content').textContent.includes('Loading work'), 'the work group does not wait forever');
});
