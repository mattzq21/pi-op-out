import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook, act, whenReactive } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';

/** A view of a conversation that another view owns. connected: whether Pi runs for this view. */
async function view(t, connected) {
  const dom = installDom();
  const calls = [];
  let listener;
  const snapshot = { revision: 'r', state: { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 's', messageCount: 0, pendingMessageCount: 0 }, history: { entries: [], leafId: null }, sequence: 1, epoch: 'e', liveTools: [], queue: { type: 'queue_state', pendingMessages: [] } };
  const transport = {
    ownsConversation: () => false,
    isConnected: () => connected,
    subscribe(next) { listener = next; return () => {}; },
    async command(command) {
      calls.push(command.type);
      if (!connected) throw new Error('Pi is not running');
      return { get_session_revision: { revision: 'x' }, get_snapshot: snapshot, get_commands: { commands: [] }, get_available_models: { models: [] }, get_available_thinking_levels: { levels: ['off'] }, get_session_stats: {} }[command.type] ?? {};
    },
  };
  const hook = await renderHook(value => useChatSession(value), transport);
  t.after(async () => { await hook.unmount(); dom.restore(); });
  return { hook, calls, emit: event => act(() => listener(event)) };
}

test('a detached view does not read the conversation, so no refresh error shows', async t => {
  const chat = await view(t, false);
  assert.equal(chat.hook.current.error, undefined);
  assert.deepEqual(chat.calls, []);
  await chat.emit({ type: 'ownership_lost' });
  assert.equal(chat.hook.current.error, undefined);
});

test('a connected view that another view owns still reads the conversation', async t => {
  const chat = await view(t, true);
  await whenReactive(() => chat.hook.current.state.sessionId === 's');
  assert.ok(chat.calls.includes('get_snapshot'));
  assert.equal(chat.hook.current.error, undefined);
});
