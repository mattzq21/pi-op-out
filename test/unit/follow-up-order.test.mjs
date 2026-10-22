import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook, renderComponent, act } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { retainSubmittedMessage } from '../../clients/ui/lib/sessionMemory.ts';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

// Message B, sent while message A has no reply yet, must not show directly under A. Pi delivers B only after the reply to A.
// Each scenario sends events in an order that Pi and Piop produce. The test records the transcript after each step.
// At no step can two user messages show one after the other, because B is delivered only after the reply to A.

const text = value => [{ type: 'text', text: value }];
const user = (type, content, timestamp, submission, queue) => ({ type, message: { role: 'user', content: text(content), timestamp, piopSubmissionId: submission, piopQueueId: queue } });
const assistant = (type, content, timestamp) => ({ type, message: { role: 'assistant', content: text(content), timestamp } });
const queued = behavior => ({ id: 'queue-b', goalSubmissionId: 'submission-b', message: 'Message B', behavior });

async function harness(t, responses = new Map()) {
  const dom = installDom();
  const transport = { subscribe() { return () => {}; }, async command(command) { const response = responses.get(command.type); return response instanceof Function ? response() : response ?? {}; } };
  const hook = await renderHook(value => useChatSession(value), transport);
  let view;
  t.after(async () => { await view?.unmount(); await hook.unmount(); dom.restore(); });
  const steps = [];
  const record = async label => {
    await dom.flushFrames();
    const noop = () => {};
    const props = { readOnly: false, onSend: noop, onAbort: noop, onPause: noop, onResume: noop, onOpenProject: noop, onBranch: noop, onModel: noop, onToggleFastMode: noop, onThinking: noop, onChangePending: async () => {}, state: hook.current.state, messages: hook.current.messages, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} };
    if (view) await view.rerender(props); else view = await renderComponent(ChatView, props);
    const shown = [];
    for (const turn of view.container.querySelectorAll('.conversation-turn')) {
      for (const item of turn.querySelectorAll('.user-message')) shown.push(item.textContent.includes('Message B') ? 'user B' : 'user A');
      if (turn.querySelector('.assistant-message')) shown.push('reply');
    }
    const queue = [...view.container.querySelectorAll('.pending-message-text')].map(item => item.textContent);
    const locked = [...view.container.querySelectorAll('.pending-message button')].every(button => button.disabled);
    steps.push({ step: label, transcript: shown.join(' | '), queue, locked });
  };
  const events = async (label, ...items) => { await act(() => items.forEach(event => hook.current.handleEvent(event))); await record(label); };
  const submit = async (label, id, content) => { await act(() => retainSubmittedMessage(transport, { id, role: 'user', content: text(content), submissionId: id })); await record(label); };
  const refresh = async label => { await act(() => hook.current.refresh()); await record(label); };
  const check = () => {
    const faults = steps.filter(({ transcript }) => /user . \| user ./.test(transcript));
    assert.deepEqual(faults, [], 'B showed directly under A before A had a reply. All steps:\n' + steps.map(({ step, transcript }) => '  ' + step + ' => ' + transcript).join('\n'));
  };
  return { events, submit, refresh, check, steps };
}

// The run of A starts: the daemon publishes its queue after delivery ("started" preflight), then Pi starts the run.
async function startA(chat, { userEvents = true } = {}) {
  await chat.submit('A submitted', 'submission-a', 'Message A');
  await chat.events('A preflight "started", daemon queue_update []', { type: 'queue_update', steering: [], followUp: [], pendingMessages: [] });
  if (!userEvents) return;
  await chat.events('agent_start, user A message_start/message_end', { type: 'agent_start' }, user('message_start', 'Message A', 100, 'submission-a', 'queue-a'), user('message_end', 'Message A', 100, 'submission-a', 'queue-a'));
}

// The reply to A ends. Pi takes B from its queue (queue_update first, then the user message), and replies to B.
async function finish(chat, behavior) {
  await chat.events('assistant message_end', assistant('message_end', 'Reply to A', 200));
  await chat.events('Pi releases B: queue_update [], user B message_start/message_end', { type: 'queue_update', steering: [], followUp: [], pendingMessages: [] }, user('message_start', 'Message B', 300, 'submission-b', 'queue-b'), user('message_end', 'Message B', 300, 'submission-b', 'queue-b'));
  await chat.events('assistant message_start/message_end for B', assistant('message_start', 'Reply to B', 400), assistant('message_end', 'Reply to B', 400), { type: 'agent_end' }, { type: 'agent_settled' });
  assert.equal(chat.steps.at(-1).transcript, 'user A | reply | user B | reply', 'the final transcript is correct (' + behavior + ')');
}

for (const behavior of ['followUp', 'steer']) {
  test('B sent as ' + behavior + ' after agent_start, before the reply to A starts, does not show directly under A', async t => {
    const chat = await harness(t);
    await startA(chat);
    await chat.submit('B submitted as ' + behavior + ' (waits for the daemon)', 'submission-b', 'Message B');
    assert.deepEqual(chat.steps.at(-1).queue, ['Message B'], 'B waits in the queue above the message box');
    assert.equal(chat.steps.at(-1).locked, true, 'B cannot be changed before the daemon queued it');
    await chat.events('daemon queue_update with B', { type: 'queue_update', steering: behavior === 'steer' ? ['Message B'] : [], followUp: behavior === 'followUp' ? ['Message B'] : [], pendingMessages: [queued(behavior)] });
    await chat.events('assistant message_start for A', assistant('message_start', 'Reply to A', 200));
    await finish(chat, behavior);
    chat.check();
  });

  test('B sent as ' + behavior + ' before the reply to A starts, with the reply before the daemon queues B, does not show directly under A', async t => {
    const chat = await harness(t);
    await startA(chat);
    await chat.submit('B submitted as ' + behavior + ' (waits for the daemon)', 'submission-b', 'Message B');
    await chat.events('assistant message_start for A', assistant('message_start', 'Reply to A', 200));
    await chat.events('daemon queue_update with B', { type: 'queue_update', steering: behavior === 'steer' ? ['Message B'] : [], followUp: behavior === 'followUp' ? ['Message B'] : [], pendingMessages: [queued(behavior)] });
    await finish(chat, behavior);
    chat.check();
  });
}

test('B sent before agent_start and user A message_start arrive does not show directly under A', async t => {
  const chat = await harness(t);
  await startA(chat, { userEvents: false });
  // The prompt response of A arrived, but its run events did not. The composer is not streaming, so B goes as a prompt that the daemon queues as a follow-up.
  await chat.submit('B submitted as prompt (waits for the daemon)', 'submission-b', 'Message B');
  await chat.events('agent_start, user A message_start/message_end', { type: 'agent_start' }, user('message_start', 'Message A', 100, 'submission-a', 'queue-a'), user('message_end', 'Message A', 100, 'submission-a', 'queue-a'));
  await chat.events('daemon queue_update with B', { type: 'queue_update', steering: [], followUp: ['Message B'], pendingMessages: [queued('followUp')] });
  await chat.events('assistant message_start for A', assistant('message_start', 'Reply to A', 200));
  await finish(chat, 'followUp');
  chat.check();
});

test('B does not show directly under A after a snapshot refresh while B waits for the daemon', async t => {
  const entries = [{ type: 'message', id: 'entry-a', parentId: null, message: { role: 'user', content: text('Message A'), timestamp: 100, piopSubmissionId: 'submission-a', piopQueueId: 'queue-a' } }];
  const state = { model: null, thinkingLevel: 'off', isStreaming: true, sessionId: 'session', messageCount: 1, pendingMessageCount: 0 };
  const responses = new Map([['get_session_revision', { revision: 'changed' }], ['get_snapshot', { revision: 'snapshot', state, history: { entries, leafId: 'entry-a' }, sequence: 10, epoch: 'epoch', liveTools: [], queue: { type: 'queue_update', steering: [], followUp: [], pendingMessages: [] } }], ['get_available_models', { models: [] }], ['get_available_thinking_levels', { levels: ['off'] }], ['get_commands', { commands: [] }], ['get_session_stats', {}]]);
  const chat = await harness(t, responses);
  await startA(chat);
  await chat.submit('B submitted as followUp (waits for the daemon)', 'submission-b', 'Message B');
  await chat.refresh('snapshot: history [A], queue []');
  await chat.events('daemon queue_update with B', { type: 'queue_update', steering: [], followUp: ['Message B'], pendingMessages: [queued('followUp')] });
  await chat.events('assistant message_start for A', assistant('message_start', 'Reply to A', 200));
  await finish(chat, 'followUp');
  chat.check();
});


test('a message sent after a task that ended without a reply shows at once', async t => {
  const chat = await harness(t);
  await startA(chat);
  await chat.events('A ends without a reply', { type: 'agent_end' }, { type: 'agent_settled' });
  await chat.submit('B submitted while idle', 'submission-b', 'Message B');
  assert.equal(chat.steps.at(-1).transcript, 'user A | user B');
});
