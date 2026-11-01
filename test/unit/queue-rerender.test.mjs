import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook, renderComponent, act } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { retainSubmittedMessage } from '../../clients/ui/lib/sessionMemory.ts';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

const text = value => [{ type: 'text', text: value }];

async function chat(t) {
  const dom = installDom();
  const transport = { subscribe() { return () => {}; }, async command() { return {}; } };
  const hook = await renderHook(value => useChatSession(value), transport);
  const noop = () => {};
  const change = async () => {};
  const props = () => ({ readOnly: false, onSend: noop, onAbort: noop, onOpenProject: noop, onBranch: noop, onModel: noop, onToggleFastMode: noop, onThinking: noop, onChangePending: change, state: hook.current.state, messages: hook.current.messages, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} });
  const view = await renderComponent(ChatView, props());
  t.after(async () => { await view.unmount(); await hook.unmount(); dom.restore(); });
  const settle = async () => { await dom.flushFrames(); await view.rerender(props()); await dom.flushFrames(); };
  const events = async (...items) => { await act(() => items.forEach(event => hook.current.handleEvent(event))); await settle(); };
  for (let turn = 0; turn < 3; turn++) await events({ type: 'agent_start' }, { type: 'message_end', message: { role: 'user', content: text('Question ' + turn), timestamp: 10 + turn * 3 } }, { type: 'message_end', message: { role: 'assistant', content: text('Answer ' + turn), timestamp: 11 + turn * 3, stopReason: 'stop' } }, { type: 'agent_end' }, { type: 'agent_settled' });
  const removedBy = async step => {
    const before = [...view.container.querySelectorAll('*')];
    await step();
    const after = new Set(view.container.querySelectorAll('*'));
    return before.filter(node => !after.has(node)).map(node => node.tagName.toLowerCase() + (node.classList[0] ? '.' + node.classList[0] : ''));
  };
  const submit = message => async () => { await act(() => retainSubmittedMessage(transport, message)); await settle(); };
  return { events, removedBy, submit, queue: () => [...view.container.querySelectorAll('.pending-message-text')].map(node => node.textContent) };
}

const queued = held => ({ type: 'queue_update', steering: [], followUp: held ? [] : ['Check the tests'], pendingMessages: [{ id: 'queue-1', goalSubmissionId: 'submission-1', message: 'Check the tests', behavior: 'followUp', ...(held ? { held: true } : {}) }], held });

test('queueing a message while the reply streams changes only the queue: no turn or message is rebuilt', async t => {
  const view = await chat(t);
  await view.events({ type: 'agent_start' }, { type: 'message_end', message: { role: 'user', content: text('Question 3'), timestamp: 40 } }, { type: 'message_start', message: { role: 'assistant', content: text('Answer 3 so far'), timestamp: 41 } });
  assert.deepEqual(await view.removedBy(view.submit({ id: 'submission-1', role: 'user', content: text('Check the tests'), submissionId: 'submission-1', deliveryBehavior: 'followUp' })), []);
  assert.deepEqual(await view.removedBy(() => view.events(queued(false))), []);
  assert.deepEqual(view.queue(), ['Check the tests']);
});

test('queueing a message while the queue is on hold changes only the queue: no turn, message or queue row is rebuilt', async t => {
  const view = await chat(t);
  await view.events({ type: 'queue_update', steering: [], followUp: [], pendingMessages: [], held: true });
  assert.deepEqual(await view.removedBy(view.submit({ id: 'submission-1', role: 'user', content: text('Check the tests'), submissionId: 'submission-1' })), []);
  assert.deepEqual(await view.removedBy(() => view.events(queued(true))), []);
  assert.deepEqual(view.queue(), ['Check the tests']);
});
