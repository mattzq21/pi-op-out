import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const toolResult = (messages: any[], tool: string) => {
  const call = messages.findLast(message => message.role === 'assistant' && message.tool_calls?.some((item: any) => item.function.name === tool))?.tool_calls.find((item: any) => item.function.name === tool);
  return call && JSON.parse(text(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id)));
};

test('a chat can message another chat, wait for its answer and read it', async () => {
  const worker = await agents.rootChat();
  agents.scripts.set('You are the worker', messages => ({ text: text(messages.at(-1)).includes('What is the build status?') ? 'Worker status: green' : 'Ready.' }));
  await worker.command({ type: 'prompt', message: 'You are the worker' });
  await worker.until(history => text(history.at(-1)) === 'Ready.');

  await agents.enableAgentTools('send_message');
  const coordinator = await agents.rootChat();
  agents.scripts.set('Check on the worker', messages => {
    if (!called(messages, 'send_message_to_thread')) return { tool: 'send_message_to_thread', arguments: { threadId: worker.sessionId, prompt: 'What is the build status?' } };
    if (!called(messages, 'wait_threads')) return { tool: 'wait_threads', arguments: { targets: [{ threadId: worker.sessionId }], timeoutMs: 60000 } };
    if (!called(messages, 'read_thread')) return { tool: 'read_thread', arguments: { threadId: worker.sessionId, limit: 2 } };
    return { text: 'Relay: ' + toolResult(messages, 'read_thread').items.at(-1).text };
  });
  await coordinator.command({ type: 'prompt', message: 'Check on the worker' });
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Worker status: green');
  const seen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Check on the worker')).messages;
  expect(toolResult(seen, 'send_message_to_thread')).toMatchObject({ sessionId: worker.sessionId, accepted: true });
  expect(toolResult(seen, 'wait_threads')).toMatchObject({ timedOut: false, wake: { id: worker.sessionId, status: 'idle' }, polls: [{ latestAssistantMessage: { text: 'Worker status: green' } }] });
  const delivered = JSON.parse(toolResult(seen, 'read_thread').items[0].text);
  // The chat view shows the sender from sourceHostId and sourceSessionId.
  expect(delivered).toMatchObject({ sourceSessionId: coordinator.sessionId, sourceHostId: 'local', message: 'What is the build status?' });
}, 120000);

test('chat tools list and read only root chats, never subagent chats', async () => {
  await agents.enableAgentTools('send_message');
  const coordinator = await agents.rootChat();
  let childId = '';
  agents.scripts.set('Delegate, then look around', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'helper', message: 'Helper task' } };
    if (!last.includes('helped') && !called(messages, 'list_threads')) return { text: 'Waiting.' };
    if (!called(messages, 'list_threads')) return { tool: 'list_threads' };
    if (!called(messages, 'read_thread')) return { tool: 'read_thread', arguments: { threadId: childId } };
    return { text: 'Relay: ' + last };
  });
  agents.scripts.set('Helper task', () => ({ text: 'helped' }));
  await coordinator.command({ type: 'prompt', message: 'Delegate, then look around' });
  await coordinator.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'spawn_agent'));
  childId = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.subagentParentId === coordinator.sessionId).id;
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Chat orchestration can only target root agents; use the subagent tools for delegated work');
  const seen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Delegate, then look around')).messages;
  const listed = JSON.stringify(toolResult(seen, 'list_threads'));
  expect([listed.includes(coordinator.sessionId), listed.includes(childId)]).toEqual([true, false]);
}, 120000);

test('a chat can start a new independent chat that works on its prompt', async () => {
  await agents.enableAgentTools('send_message');
  const coordinator = await agents.rootChat();
  agents.scripts.set('Open a release chat', messages => {
    if (!called(messages, 'create_thread')) return { tool: 'create_thread', arguments: { title: 'Release notes', prompt: 'Draft the release notes' } };
    const created = toolResult(messages, 'create_thread');
    if (!called(messages, 'wait_threads')) return { tool: 'wait_threads', arguments: { targets: [{ threadId: created.threadId }], timeoutMs: 60000 } };
    return { text: 'Relay: ' + toolResult(messages, 'wait_threads').polls[0].latestAssistantMessage.text };
  });
  agents.scripts.set('Draft the release notes', () => ({ text: 'Notes drafted.' }));
  await coordinator.command({ type: 'prompt', message: 'Open a release chat' });
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Notes drafted.');
  const seen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Open a release chat')).messages;
  const created = toolResult(seen, 'create_thread');
  expect(created.submitted).toBe(true);
  const session = (await agents.daemon.invoke('list_sessions')).find((item: any) => item.id === created.threadId);
  expect(session).toMatchObject({ name: 'Release notes' });
  expect(session.subagentParentId).toBeUndefined();
}, 120000);

/** A promise that the test settles later, to keep an agent's model reply waiting. */
const held = <T>() => { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; };

test('a chat can stop another chat\'s running work, which keeps its history and stays usable', async () => {
  await agents.enableAgentTools('send_message');
  const worker = await agents.rootChat();
  const longReply = held<{ text: string }>();
  agents.scripts.set('Long job', messages => text(messages.at(-1)).includes('Are you still there?') ? { text: 'Still here.' } : longReply.promise);
  await worker.command({ type: 'prompt', message: 'Long job' });
  await worker.until(() => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Long job')));
  const coordinator = await agents.rootChat();
  agents.scripts.set('Stop the worker', messages => {
    if (!called(messages, 'stop_thread')) return { tool: 'stop_thread', arguments: { threadId: worker.sessionId } };
    if (!called(messages, 'send_message_to_thread')) return { tool: 'send_message_to_thread', arguments: { threadId: worker.sessionId, prompt: 'Are you still there?' } };
    return { text: 'Relay: done' };
  });
  try {
    await coordinator.command({ type: 'prompt', message: 'Stop the worker' });
    await coordinator.until(history => text(history.at(-1)) === 'Relay: done');
    const history = await worker.until(messages => text(messages.at(-1)) === 'Still here.');
    expect(text(history.find(message => message.role === 'user'))).toBe('Long job');
    expect(history.some(message => message.role === 'assistant' && message.stopReason === 'aborted')).toBe(true);
  } finally { longReply.release({ text: 'too late' }); }
  expect(text((await worker.history()).at(-1))).toBe('Still here.');
}, 120000);

test('a message to a busy chat waits until its current work finishes, then starts a new turn', async () => {
  await agents.enableAgentTools('send_message');
  const worker = await agents.rootChat();
  const longReply = held<{ text: string }>();
  agents.scripts.set('Busy job', messages => text(messages.at(-1)).includes('Queued question') ? { text: 'Answer to the queued question.' } : longReply.promise);
  await worker.command({ type: 'prompt', message: 'Busy job' });
  await worker.until(() => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Busy job')));
  const coordinator = await agents.rootChat();
  agents.scripts.set('Ask the busy worker', messages => called(messages, 'send_message_to_thread')
    ? { text: 'Relay: ' + JSON.stringify(toolResult(messages, 'send_message_to_thread')) }
    : { tool: 'send_message_to_thread', arguments: { threadId: worker.sessionId, prompt: 'Queued question' } });
  try {
    await coordinator.command({ type: 'prompt', message: 'Ask the busy worker' });
    const receipt = JSON.parse(text((await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '))).at(-1)).slice('Relay: '.length));
    expect(receipt).toMatchObject({ sessionId: worker.sessionId, accepted: true });
    const workerRequests = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Busy job'));
    expect(workerRequests.some(request => JSON.stringify(request.messages).includes('Queued question'))).toBe(false);
  } finally { longReply.release({ text: 'Busy job done.' }); }
  const answers = (await worker.until(messages => text(messages.at(-1)) === 'Answer to the queued question.')).filter(message => message.role === 'assistant').map(message => [text(message), message.stopReason]);
  expect(answers).toEqual([['Busy job done.', 'stop'], ['Answer to the queued question.', 'stop']]);
}, 120000);
