import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); await agents.enableAgentTools('message_thread', 'spawn_subagents'); }, 60000);
afterAll(async () => { await agents?.close(); });

const startedWith = (request: any, prompt: string) => text(request.messages.find((message: any) => message.role === 'user')) === prompt;

const toolResult = (messages: any[], tool: string) => {
  const call = messages.findLast(message => message.role === 'assistant' && message.tool_calls?.some((item: any) => item.function.name === tool))?.tool_calls.find((item: any) => item.function.name === tool);
  return call && JSON.parse(text(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id)));
};

test.concurrent('a chat can message another chat, wait for its answer and read it', async () => {
  const worker = await agents.rootChat();
  agents.scripts.set('You are the worker', messages => ({ text: text(messages.at(-1)).includes('What is the build status?') ? 'Worker status: green' : 'Ready.' }));
  await worker.command({ type: 'prompt', message: 'You are the worker' });
  await worker.until(history => text(history.at(-1)) === 'Ready.');

  const coordinator = await agents.rootChat();
  agents.scripts.set('Check on the worker', messages => {
    if (!called(messages, 'message_thread')) return { tool: 'message_thread', arguments: { threadId: worker.sessionId, message: 'What is the build status?' } };
    if (!called(messages, 'wait_threads')) return { tool: 'wait_threads', arguments: { targets: [{ threadId: worker.sessionId }], timeoutMs: 60000 } };
    if (!called(messages, 'read_thread')) return { tool: 'read_thread', arguments: { threadId: worker.sessionId, limit: 2 } };
    return { text: 'Relay: ' + toolResult(messages, 'read_thread').items.at(-1).text };
  });
  await coordinator.command({ type: 'prompt', message: 'Check on the worker' });
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Worker status: green');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Check on the worker')).messages;
  expect(toolResult(seen, 'message_thread')).toMatchObject({ sessionId: worker.sessionId, accepted: true });
  expect(toolResult(seen, 'wait_threads')).toMatchObject({ timedOut: false, wake: { id: worker.sessionId, status: 'idle' }, polls: [{ latestAssistantMessage: { text: 'Worker status: green' } }] });
  const delivered = JSON.parse(toolResult(seen, 'read_thread').items[0].text);
  // The chat view shows the sender from sourceHostId and sourceSessionId.
  expect(delivered).toMatchObject({ sourceSessionId: coordinator.sessionId, sourceHostId: 'local', message: 'What is the build status?' });
}, 120000);

test.concurrent('chat tools list and read only root chats, never subagent chats', async () => {
  const coordinator = await agents.rootChat();
  let childId = '';
  const childKnown = Promise.withResolvers<void>();
  agents.scripts.set('Delegate, then look around', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ name: 'helper', task: 'Helper task' }] } };
    if (!last.includes('helped') && !called(messages, 'list_threads')) return { text: 'Waiting.' };
    if (!called(messages, 'list_threads')) return { tool: 'list_threads' };
    if (!called(messages, 'read_thread')) return { tool: 'read_thread', arguments: { threadId: childId } };
    return { text: 'Relay: ' + last };
  });
  agents.scripts.set('Helper task', async () => { await childKnown.promise; return { text: 'helped' }; });
  await coordinator.command({ type: 'prompt', message: 'Delegate, then look around' });
  await coordinator.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'spawn_subagents'));
  childId = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.subagentParentId === coordinator.sessionId).id;
  childKnown.resolve();
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: This is a subagent chat; use the subagent tools for it');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Delegate, then look around')).messages;
  const listed = JSON.stringify(toolResult(seen, 'list_threads'));
  expect([listed.includes(coordinator.sessionId), listed.includes(childId)]).toEqual([true, false]);
}, 120000);

test.concurrent('a chat can start a new independent chat that works on its prompt', async () => {
  const coordinator = await agents.rootChat();
  agents.scripts.set('Open a release chat', messages => {
    if (!called(messages, 'create_thread')) return { tool: 'create_thread', arguments: { title: 'Release notes', message: 'Draft the release notes' } };
    const created = toolResult(messages, 'create_thread');
    if (!called(messages, 'wait_threads')) return { tool: 'wait_threads', arguments: { targets: [{ threadId: created.threadId }], timeoutMs: 60000 } };
    return { text: 'Relay: ' + toolResult(messages, 'wait_threads').polls[0].latestAssistantMessage.text };
  });
  agents.scripts.set('Draft the release notes', () => ({ text: 'Notes drafted.' }));
  await coordinator.command({ type: 'prompt', message: 'Open a release chat' });
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Notes drafted.');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Open a release chat')).messages;
  const created = toolResult(seen, 'create_thread');
  expect(created.error).toBeUndefined();
  const session = (await agents.daemon.invoke('list_sessions')).find((item: any) => item.id === created.threadId);
  expect(session).toMatchObject({ name: 'Release notes' });
  expect(session.subagentParentId).toBeUndefined();
}, 120000);

/** A promise that the test settles later, to keep an agent's model reply waiting. */
const held = <T>() => { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; };

test.concurrent('a chat can stop another chat\'s running work, which keeps its history and stays usable', async () => {
  const worker = await agents.rootChat();
  const longReply = held<{ text: string }>();
  agents.scripts.set('Long job', messages => text(messages.at(-1)).includes('Are you still there?') ? { text: 'Still here.' } : longReply.promise);
  await worker.command({ type: 'prompt', message: 'Long job' });
  await worker.until(() => agents.model.requests.some(request => startedWith(request, 'Long job')));
  const coordinator = await agents.rootChat();
  agents.scripts.set('Stop the worker', messages => {
    if (!called(messages, 'stop_thread')) return { tool: 'stop_thread', arguments: { threadId: worker.sessionId } };
    if (!called(messages, 'message_thread')) return { tool: 'message_thread', arguments: { threadId: worker.sessionId, message: 'Are you still there?' } };
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

test.concurrent('a message to a busy chat waits until its current work finishes, then starts a new turn', async () => {
  const worker = await agents.rootChat();
  const longReply = held<{ text: string }>();
  agents.scripts.set('Busy job', messages => text(messages.at(-1)).includes('Queued question') ? { text: 'Answer to the queued question.' } : longReply.promise);
  await worker.command({ type: 'prompt', message: 'Busy job' });
  await worker.until(() => agents.model.requests.some(request => startedWith(request, 'Busy job')));
  const coordinator = await agents.rootChat();
  agents.scripts.set('Ask the busy worker', messages => called(messages, 'message_thread')
    ? { text: 'Relay: ' + JSON.stringify(toolResult(messages, 'message_thread')) }
    : { tool: 'message_thread', arguments: { threadId: worker.sessionId, message: 'Queued question' } });
  try {
    await coordinator.command({ type: 'prompt', message: 'Ask the busy worker' });
    const receipt = JSON.parse(text((await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '))).at(-1)).slice('Relay: '.length));
    expect(receipt).toMatchObject({ sessionId: worker.sessionId, accepted: true });
    const workerRequests = agents.model.requests.filter(request => startedWith(request, 'Busy job'));
    expect(workerRequests.some(request => JSON.stringify(request.messages).includes('Queued question'))).toBe(false);
  } finally { longReply.release({ text: 'Busy job done.' }); }
  const answers = (await worker.until(messages => text(messages.at(-1)) === 'Answer to the queued question.')).filter(message => message.role === 'assistant').map(message => [text(message), message.stopReason]);
  expect(answers).toEqual([['Busy job done.', 'stop'], ['Answer to the queued question.', 'stop']]);
}, 120000);

test.concurrent('a chat that tries to message itself is told to choose another chat, and nothing is delivered', async () => {
  const chat = await agents.rootChat();
  agents.scripts.set('Message myself', messages => called(messages, 'message_thread') ? { text: 'Told: ' + text(messages.at(-1)) } : { tool: 'message_thread', arguments: { threadId: chat.sessionId, message: 'Hello me' } });
  await chat.command({ type: 'prompt', message: 'Message myself' });
  const history = await chat.until(messages => text(messages.at(-1)).startsWith('Told: '));
  expect(text(history.at(-1))).toBe('Told: Choose another conversation as the recipient');
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled');
  expect((await chat.command({ type: 'get_state' })).pendingMessageCount).toBe(0);
  expect((await chat.history()).filter(message => message.role === 'user').map(text)).toEqual(['Message myself']);
}, 60000);

test.concurrent('messaging or waiting for a chat that does not exist tells the agent so in plain words', async () => {
  const missing = '11111111-2222-3333-4444-555555555555';
  agents.scripts.set('Message a missing chat', messages => called(messages, 'message_thread') ? { text: 'Told: ' + text(messages.at(-1)) } : { tool: 'message_thread', arguments: { threadId: missing, message: 'Hello?' } });
  agents.scripts.set('Wait for a missing chat', messages => called(messages, 'wait_threads') ? { text: 'Told: ' + text(messages.at(-1)) } : { tool: 'wait_threads', arguments: { targets: [{ threadId: missing }], timeoutMs: 2000 } });
  const sender = await agents.rootChat();
  await sender.command({ type: 'prompt', message: 'Message a missing chat' });
  expect(text((await sender.until(messages => text(messages.at(-1)).startsWith('Told: '))).at(-1))).toBe('Told: Conversation was not found in active or archived storage');
  const waiter = await agents.rootChat();
  await waiter.command({ type: 'prompt', message: 'Wait for a missing chat' });
  const told = JSON.parse(text((await waiter.until(messages => text(messages.at(-1)).startsWith('Told: '))).at(-1)).slice('Told: '.length));
  expect(told.errors).toEqual([{ threadId: missing, error: 'Conversation was not found in active or archived storage' }]);
}, 60000);

test('list_agent_profiles follows the tool groups and lists the descriptions of agents that can start', async () => {
  const setup = await agents.rootChat();
  const setTools = async (tools: string[]) => {
    const configuration = await setup.command({ type: 'get_agent_configuration' });
    const general = configuration.agents.find((agent: any) => agent.name === 'general');
    const helper = { ...general, name: 'helper', isDefault: undefined, description: 'Finds files.', allow_as_thread: false, tools: ['read'] };
    await setup.command({ type: 'configure_agents', configuration: { revision: configuration.revision, agents: [...configuration.agents.filter((agent: any) => !['general', 'helper'].includes(agent.name)), { ...general, tools }, helper] } });
  };
  const profilesTool = (prompt: string) => agents.model.requests.find(request => startedWith(request, prompt)).tools?.find((tool: any) => tool.function.name === 'list_agent_profiles')?.function;
  const listed = async (prompt: string, args: object) => {
    agents.scripts.set(prompt, messages => called(messages, 'list_agent_profiles') ? { text: 'Listed: ' + text(messages.at(-1)) } : { tool: 'list_agent_profiles', arguments: args });
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: prompt });
    const answer = text((await chat.until(messages => text(messages.at(-1)).startsWith('Listed: '))).at(-1)).slice('Listed: '.length);
    return { tool: profilesTool(prompt), answer };
  };

  await setTools(['read', 'create_thread']);
  const threads = await listed('List thread agents', {});
  expect(threads.tool.parameters.properties).toEqual({});
  // helper is not usable as a thread.
  expect(JSON.parse(threads.answer).map((profile: any) => profile.name)).not.toContain('helper');

  await setTools(['read', 'spawn_subagents', 'create_thread']);
  const both = await listed('List subagent agents', { for: 'subagent' });
  expect(both.tool.parameters.required).toEqual(['for']);
  expect(JSON.parse(both.answer).find((profile: any) => profile.name === 'helper')).toMatchObject({ description: 'Finds files.' });

  await setTools(['read']);
  agents.scripts.set('No agent tools', () => ({ text: 'Done' }));
  const plain = await agents.rootChat();
  await plain.command({ type: 'prompt', message: 'No agent tools' });
  await plain.until(messages => text(messages.at(-1)) === 'Done');
  expect(profilesTool('No agent tools')).toBeUndefined();
}, 120000);
