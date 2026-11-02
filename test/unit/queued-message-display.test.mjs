import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook, renderComponent, act } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { retainSubmittedMessage } from '../../clients/ui/lib/sessionMemory.ts';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

for (const remaining of [[], [{ id: 'queue-last', goalSubmissionId: 'last', message: 'Check the path', behavior: 'followUp' }]]) test(`releasing a held queue with ${remaining.length + 1} waiting messages does not show a normal submission as a second sent message`, async t => {
  const dom = installDom();
  const transport = { subscribe() { return () => {}; }, async command() { return {}; } };
  const hook = await renderHook(value => useChatSession(value), transport);
  let view;
  t.after(async () => { await view?.unmount(); await hook.unmount(); dom.restore(); });
  const queued = { id: 'queue-next', goalSubmissionId: 'next', message: 'Also add the provider', behavior: 'followUp' };
  const send = async (...events) => {
    await act(() => events.forEach(event => hook.current.handleEvent(event)));
    await dom.flushFrames();
    const props = { readOnly: false, state: hook.current.state, messages: hook.current.messages, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} };
    if (view) await view.rerender(props);
    else view = await renderComponent(ChatView, props);
  };
  const message = (type, role, content, timestamp, extra = {}) => ({ type, message: { role, content, timestamp, ...extra } });
  await send(
    { type: 'agent_start' },
    message('message_start', 'user', 'Change the indicators', 100),
    message('message_end', 'user', 'Change the indicators', 100),
    message('message_start', 'assistant', 'Working on the indicators', 200),
    { type: 'queue_update', held: true, pendingMessages: [] },
  );
  const original = view.container.querySelector('.conversation-turn');
  await act(() => {
    for (const item of [queued, ...remaining]) retainSubmittedMessage(transport, { id: item.goalSubmissionId, role: 'user', content: item.message });
  });
  await send({ type: 'queue_update', held: true, pendingMessages: [queued, ...remaining] });
  const checkRunning = () => {
    assert.equal(view.container.querySelectorAll('.conversation-turn').length, 1, 'the next queued message must not appear as sent while the first answer is running');
    assert.equal(view.container.querySelector('.conversation-turn'), original);
    assert.ok(original.querySelector('.active-work-content'), 'the current answer must stay open');
    assert.equal(original.querySelector('.work-group'), null, 'running work must not collapse');
    assert.doesNotMatch(original.textContent, /Also add the provider/);
    assert.match(view.container.querySelector('.pending-message').textContent, /Also add the provider/);
  };
  checkRunning();
  await send({ type: 'queue_update', held: false, pendingMessages: [queued, ...remaining] });
  checkRunning();
  await send({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' });
  checkRunning();
  await send({ type: 'queue_update', held: false, pendingMessages: [{ ...queued, sending: true }, ...remaining] });
  checkRunning();
  await send(
    { type: 'tool_execution_end', toolCallId: 'call' },
    message('message_end', 'assistant', 'Indicators done', 200),
    message('message_start', 'user', queued.message, 300, { piopSubmissionId: 'next', piopQueueId: queued.id }),
    message('message_end', 'user', queued.message, 300, { piopSubmissionId: 'next', piopQueueId: queued.id }),
    { type: 'queue_update', held: false, pendingMessages: remaining },
    message('message_start', 'assistant', 'Adding the provider', 400),
  );
  const turns = view.container.querySelectorAll('.conversation-turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0], original);
  assert.match(turns[1].textContent, /Also add the provider/);
  assert.ok(turns[1].querySelector('.active-work-content'));
  assert.equal(view.container.querySelectorAll('.pending-message').length, remaining.length);
  if (remaining.length) assert.match(view.container.querySelector('.pending-message').textContent, /Check the path/);
  assert.equal(hook.current.messages.filter(item => item.role === 'user' && item.content === queued.message).length, 1);
});

for (const behavior of ['followUp', 'steer']) test(`${behavior} stays queued while tools and text remain in the running reply`, async t => {
  const dom = installDom();
  const transport = { subscribe() { return () => {}; }, async command() { return {}; } };
  const hook = await renderHook(value => useChatSession(value), transport);
  let view;
  t.after(async () => { await view?.unmount(); await hook.unmount(); dom.restore(); });
  const show = async () => {
    const props = { readOnly: true, state: hook.current.state, messages: hook.current.messages, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} };
    if (view) await view.rerender(props);
    else view = await renderComponent(ChatView, props);
  };
  const send = async (...events) => {
    await act(() => events.forEach(event => hook.current.handleEvent(event)));
    await dom.flushFrames();
    await show();
  };
  const message = (type, role, content, timestamp, extra = {}) => ({ type, message: { role, content, timestamp, ...extra } });
  await send(
    { type: 'agent_start' },
    message('message_start', 'user', 'First question', 100),
    message('message_end', 'user', 'First question', 100),
    message('message_start', 'assistant', 'Partial answer', 200),
  );
  const original = view.container.querySelector('.conversation-turn');
  await act(() => retainSubmittedMessage(transport, { id: 'submission', role: 'user', content: 'Next question', deliveryBehavior: behavior }));
  const queued = { id: 'queued', goalSubmissionId: 'submission', message: 'Next question', behavior };
  await send({ type: 'queue_update', pendingMessages: [queued] });
  const checkRunning = () => {
    assert.equal(view.container.querySelectorAll('.conversation-turn').length, 1, 'a queued message must not start a transcript turn');
    assert.equal(view.container.querySelector('.conversation-turn'), original, 'the running reply keeps its existing elements');
    assert.ok(original.querySelector('.active-work-content'));
    assert.equal(original.querySelector('.work-group'), null, 'running work must not collapse as completed');
    assert.doesNotMatch(original.textContent, /Next question/);
    assert.equal(hook.current.state.pendingMessages[0].id, queued.id, 'the queued message remains available to the composer');
  };
  checkRunning();
  await send({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' });
  checkRunning();
  assert.ok(original.querySelector('.tool-event'), 'the tool belongs to the running reply');
  assert.deepEqual(hook.current.messages.map(item => item.role), ['user', 'assistant', 'tool', 'user']);
  await send(
    { type: 'tool_execution_end', toolCallId: 'call' },
    message('message_end', 'assistant', 'Partial answer', 200),
    message('message_start', 'assistant', 'More text', 300),
  );
  checkRunning();
  assert.match(original.textContent, /More text/);
  await send(message('message_end', 'assistant', 'Done', 300), { type: 'agent_end' });
  assert.equal(view.container.querySelectorAll('.conversation-turn').length, 1, 'waiting messages stay queued even after the reply ends');
  await send(
    { type: 'agent_start' },
    message('message_start', 'user', 'Next question', 400, { piopSubmissionId: 'submission', piopQueueId: 'queued' }),
    message('message_end', 'user', 'Next question', 400, { piopSubmissionId: 'submission', piopQueueId: 'queued' }),
    { type: 'queue_update', pendingMessages: [] },
    message('message_start', 'assistant', 'Next answer', 500),
  );
  const turns = view.container.querySelectorAll('.conversation-turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0], original);
  assert.equal(turns[0].querySelector('.active-work-content'), null);
  assert.ok(turns[1].querySelector('.active-work-content'));
  assert.match(turns[1].textContent, /Next question/);
  assert.match(turns[1].textContent, /Next answer/);
  assert.equal(hook.current.messages.filter(item => item.role === 'user' && item.content === 'Next question').length, 1);
});
