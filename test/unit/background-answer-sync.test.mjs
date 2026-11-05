import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoot } from 'solid-js';
import { installDom } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { recentHistory } from '../../daemon/src/host/views/history_window.ts';

const state = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', messageCount: 2, pendingMessageCount: 0 };
const messages = [{ role: 'user', content: 'Question', timestamp: 100 }, { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop', timestamp: 101 }];

test('a chat in the background loads its finished answer when a refresh starts at once after its session is made', async t => {
  const dom = installDom();
  t.after(() => dom.restore());
  const entries = messages.map((message, index) => ({ type: 'message', id: 'e' + index, parentId: index ? 'e' + (index - 1) : null, message }));
  const snapshot = { revision: 'epoch:1', state, history: recentHistory({ entries, leafId: 'e1' }, true), sequence: 1, epoch: 'epoch', liveTools: [], queue: { type: 'queue_state', pendingMessages: [] } };
  const responses = { get_session_revision: { revision: 'epoch:1' }, get_snapshot: snapshot, get_commands: { commands: [] }, get_available_models: { models: [] }, get_available_thinking_levels: { levels: ['off'] }, get_session_stats: {} };
  const transport = { subscribe: () => () => {}, command: async command => responses[command.type] };
  let session, dispose;
  const refresh = createRoot(stop => { dispose = stop; session = useChatSession(() => transport, undefined, { poll: false }); return session.refresh(); });
  t.after(() => dispose());
  await refresh;
  assert.equal(session.messages.at(-1).content[0].text, 'Answer');
});
