import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoot } from 'solid-js';
import { installDom, renderComponent, act } from '../dom.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';
import { useSessionMemory } from '../../clients/ui/lib/sessionMemory.ts';
import { olderHistoryMarker } from '../../clients/ui/lib/historyWindow.ts';
import { CommandRejectedError } from '../../clients/ui/lib/commandRejected.ts';

const state = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'older', messageCount: 2, pendingMessageCount: 0 };
const recent = { id: 'recent', role: 'user', content: 'Recent message', timestamp: 2 };
const olderPage = { before: null, entries: [{ type: 'message', id: 'early', parentId: null, message: { role: 'user', content: 'Early message', timestamp: 1 } }], leafId: 'early' };

function fakeTransport(failure) {
  const listeners = new Set();
  const requests = [];
  const transport = {
    requests, connected: true,
    isConnected: () => transport.connected,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: event => [...listeners].forEach(listener => listener(event)),
    currentHostId: () => 'local', currentCwd: () => '/tmp', ownsConversation: () => true, hasSentMessage: () => true,
    command: async command => {
      requests.push(command.type);
      if (command.type === 'get_history_outline') return { responses: [] };
      if (command.type !== 'get_older_history') return {};
      if (requests.filter(type => type === 'get_older_history').length === 1) throw failure;
      return olderPage;
    },
  };
  return transport;
}

async function olderChat(t, failure) {
  const dom = installDom();
  const transport = fakeTransport(failure);
  let dispose;
  const messages = createRoot(stop => { dispose = stop; const memory = useSessionMemory(() => transport, () => state); memory.setMessages([...olderHistoryMarker('recent'), recent]); return memory; });
  const notices = [];
  const view = await renderComponent(ChatView, { readOnly: true, transport, state, messages: messages.messages, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {}, onNotice: (title, message) => notices.push(title + ': ' + message) });
  t.after(async () => { await view.unmount(); dispose(); dom.restore(); });
  const frames = () => dom.flushFrames();
  await frames(); await frames(); await frames();
  return { transport, notices, view, frames, messages };
}

test('older messages that fail during a daemon restart load again after the conversation reconnects', async t => {
  const chat = await olderChat(t, new CommandRejectedError('Pi is not running', 'daemon'));
  assert.deepEqual(chat.notices, []);
  assert.deepEqual(chat.transport.requests.filter(type => type === 'get_older_history'), ['get_older_history'], 'no new request while it waits');
  await act(() => chat.transport.emit({ type: 'connection_restored' }));
  await chat.frames(); await chat.frames(); await chat.frames();
  assert.equal(chat.transport.requests.filter(type => type === 'get_older_history').length, 2);
  assert.ok(chat.messages.messages.some(message => message.content === 'Early message'));
  assert.deepEqual(chat.notices, []);
});

test('other failures to load older messages are reported', async t => {
  const chat = await olderChat(t, new Error('History is damaged'));
  assert.deepEqual(chat.notices, ['Could not load older messages: History is damaged']);
});

test('the list of older responses loads once Pi starts, and stays with the chat when its view opens again', async t => {
  const dom = installDom();
  const requests = [];
  const listeners = new Set();
  const transport = {
    connected: false, isConnected: () => transport.connected,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    currentHostId: () => 'local', currentCwd: () => '/tmp', ownsConversation: () => true, hasSentMessage: () => true,
    command: async command => {
      requests.push(command.type);
      if (command.type !== 'get_history_outline') return {};
      if (!transport.connected) throw new Error('Pi is not running');
      return { responses: [{ id: 'early-answer', start: 'early', preview: 'Early answer' }] };
    },
  };
  let dispose;
  const memory = createRoot(stop => { dispose = stop; const value = useSessionMemory(() => transport, () => state); value.setMessages([...olderHistoryMarker('recent'), recent]); return value; });
  const props = { readOnly: true, transport, state, messages: memory.messages, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {}, onNotice: () => {} };
  let view = await renderComponent(ChatView, props);
  t.after(async () => { await view.unmount(); dispose(); dom.restore(); });
  await dom.flushFrames(); await dom.flushFrames();
  assert.equal(requests.filter(type => type === 'get_history_outline').length, 1);
  transport.connected = true;
  await act(() => [...listeners].forEach(listener => listener({ type: 'pi_started' })));
  await dom.flushFrames();
  assert.equal(requests.filter(type => type === 'get_history_outline').length, 2, 'the list loads again once Pi runs');
  assert.deepEqual(memory.memory.data.outline?.items.map(item => item.id), ['early-answer']);
  await view.unmount();
  view = await renderComponent(ChatView, props);
  await dom.flushFrames(); await dom.flushFrames();
  assert.equal(requests.filter(type => type === 'get_history_outline').length, 2, 'the opened view uses the listed responses');
});
