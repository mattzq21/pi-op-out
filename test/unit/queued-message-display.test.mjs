import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook, renderComponent, act } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { retainSubmittedMessage } from '../../clients/ui/lib/sessionMemory.ts';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

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
  await act(() => retainSubmittedMessage(transport, { id: 'submission', role: 'user', content: 'Next question' }));
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
