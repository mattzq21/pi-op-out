import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); await agents.enableAgentTools('message_peer', 'spawn_subagents'); }, 60000);
afterAll(async () => { await agents?.close(); });

const startedWith = (request: any, prompt: string) => text(request.messages.find((message: any) => message.role === 'user')) === prompt;

const toolText = (messages: any[], tool: string) => {
  const call = messages.findLast(message => message.role === 'assistant' && message.tool_calls?.some((item: any) => item.function.name === tool))?.tool_calls.find((item: any) => item.function.name === tool);
  return call && text(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id));
};
const toolResult = (messages: any[], tool: string) => JSON.parse(toolText(messages, tool));
/** The answer in an await_peers result. */
const peerAnswer = (result: string) => result.match(/^<peer_message>\nPeer [^\n]+:\n([\s\S]*)\n<\/peer_message>$/)?.[1];

test.concurrent('a chat can message another chat, wait for its answer and read it', async () => {
  const worker = await agents.rootChat();
  agents.scripts.set('You are the worker', messages => ({ text: text(messages.at(-1)).includes('What is the build status?') ? 'Worker status: green' : 'Ready.' }));
  await worker.command({ type: 'prompt', message: 'You are the worker' });
  await worker.until(history => text(history.at(-1)) === 'Ready.');

  const coordinator = await agents.rootChat();
  agents.scripts.set('Check on the worker', messages => {
    if (!called(messages, 'message_peer')) return { tool: 'message_peer', arguments: { peerId: worker.sessionId, message: 'What is the build status?' } };
    if (!called(messages, 'await_peers')) return { tool: 'await_peers', arguments: { targets: [{ peerId: worker.sessionId }], timeoutMs: 60000 } };
    if (!called(messages, 'read_peer')) return { tool: 'read_peer', arguments: { peerId: worker.sessionId, limit: 2 } };
    return { text: 'Relay: ' + toolResult(messages, 'read_peer').items.at(-1).text };
  });
  await coordinator.command({ type: 'prompt', message: 'Check on the worker' });
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Worker status: green');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Check on the worker')).messages;
  expect(toolResult(seen, 'message_peer')).toMatchObject({ sessionId: worker.sessionId, accepted: true });
  expect(toolText(seen, 'await_peers')).toBe('<peer_message>\nPeer ' + worker.sessionId + ':\nWorker status: green\n</peer_message>');
  const delivered = JSON.parse(toolResult(seen, 'read_peer').items[0].text);
  // The chat view shows the sender from sourceHostId and sourceSessionId.
  expect(delivered).toMatchObject({ sourceSessionId: coordinator.sessionId, sourceHostId: 'local', message: 'What is the build status?' });
  // The worker's model sees only a <peer_message> tag with the sender's chat name and the text.
  const workerSaw = agents.model.requests.findLast(request => startedWith(request, 'You are the worker')).messages.at(-1);
  expect([workerSaw.role, text(workerSaw)]).toEqual(['user', '<peer_message>\nPeer ' + (coordinator.name ?? coordinator.sessionId) + ':\nWhat is the build status?\n</peer_message>']);
}, 120000);

test.concurrent('await_peers with for: "all" waits until every listed peer has finished', async () => {
  const fast = await agents.rootChat();
  const slow = await agents.rootChat();
  agents.scripts.set('You are fast', messages => ({ text: text(messages.at(-1)).includes('Report') ? 'Fast done' : 'Ready.' }));
  agents.scripts.set('You are slow', async messages => {
    if (!text(messages.at(-1)).includes('Report')) return { text: 'Ready.' };
    await Bun.sleep(1500);
    return { text: 'Slow done' };
  });
  for (const [chat, prompt] of [[fast, 'You are fast'], [slow, 'You are slow']] as const) {
    await chat.command({ type: 'prompt', message: prompt });
    await chat.until(history => text(history.at(-1)) === 'Ready.');
  }
  const coordinator = await agents.rootChat();
  agents.scripts.set('Wait for both', messages => {
    if (!called(messages, 'message_peer')) return { tool: 'message_peer', arguments: { peerId: fast.sessionId, message: 'Report' } };
    if (messages.filter((message: any) => message.role === 'tool').length < 2) return { tool: 'message_peer', arguments: { peerId: slow.sessionId, message: 'Report' } };
    if (!called(messages, 'await_peers')) return { tool: 'await_peers', arguments: { targets: [{ peerId: fast.sessionId }, { peerId: slow.sessionId }], for: 'all', timeoutMs: 60000 } };
    return { text: 'Waited.' };
  });
  await coordinator.command({ type: 'prompt', message: 'Wait for both' });
  await coordinator.until(history => text(history.at(-1)) === 'Waited.');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Wait for both')).messages;
  const waited = toolText(seen, 'await_peers');
  expect(waited).toContain('Fast done');
  expect(waited).toContain('Slow done');
}, 120000);

test.concurrent('a message from another chat ends an await_peers wait, and the result says a peer message arrived', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = await agents.rootChat();
  agents.scripts.set('Stay busy', async () => { await gate; return { text: 'Busy done' }; });
  await busy.command({ type: 'prompt', message: 'Stay busy' });

  let waiting!: () => void;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  const coordinator = await agents.rootChat();
  agents.scripts.set('Wait on the busy chat', messages => {
    if (called(messages, 'await_peers')) return { text: 'Waited.' };
    waiting();
    return { tool: 'await_peers', arguments: { targets: [{ peerId: busy.sessionId }], timeoutMs: 60000 } };
  });
  try {
    await coordinator.command({ type: 'prompt', message: 'Wait on the busy chat' });
    await started;
    // Let the wait begin before the message arrives.
    await Bun.sleep(1000);
    const sender = await agents.rootChat();
    agents.scripts.set('Tell the coordinator', messages => called(messages, 'message_peer') ? { text: 'Sent.' } : { tool: 'message_peer', arguments: { peerId: coordinator.sessionId, message: 'Status?' } });
    await sender.command({ type: 'prompt', message: 'Tell the coordinator' });
    await coordinator.until(history => history.some(message => text(message) === 'Waited.'));
    const seen = agents.model.requests.find(request => startedWith(request, 'Wait on the busy chat') && called(request.messages, 'await_peers')).messages;
    expect(toolText(seen, 'await_peers')).toBe('A message from a peer arrived.');
  } finally { release(); }
}, 120000);

test.concurrent('chat tools list and read only root chats, never subagent chats', async () => {
  const coordinator = await agents.rootChat();
  let childId = '';
  const childKnown = Promise.withResolvers<void>();
  agents.scripts.set('Delegate, then look around', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Helper', task: 'Helper task' }] } };
    if (!last.includes('helped') && !called(messages, 'list_peers')) return { text: 'Waiting.' };
    if (!called(messages, 'list_peers')) return { tool: 'list_peers' };
    if (!called(messages, 'read_peer')) return { tool: 'read_peer', arguments: { peerId: childId } };
    return { text: 'Relay: ' + last };
  });
  agents.scripts.set('Helper task', async () => { await childKnown.promise; return { text: 'helped' }; });
  await coordinator.command({ type: 'prompt', message: 'Delegate, then look around' });
  await coordinator.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'spawn_subagents'));
  childId = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.subagentParentId === coordinator.sessionId).id;
  childKnown.resolve();
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: This is a subagent, not a peer; use the subagent tools for it');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Delegate, then look around')).messages;
  const listed = JSON.stringify(toolResult(seen, 'list_peers'));
  expect([listed.includes(coordinator.sessionId), listed.includes(childId)]).toEqual([true, false]);
}, 120000);

test.concurrent('a chat can start a new independent chat that works on its prompt', async () => {
  const coordinator = await agents.rootChat();
  agents.scripts.set('Open a release chat', messages => {
    if (!called(messages, 'create_peer')) return { tool: 'create_peer', arguments: { title: 'Release notes', message: 'Draft the release notes' } };
    const created = toolResult(messages, 'create_peer');
    if (!called(messages, 'await_peers')) return { tool: 'await_peers', arguments: { targets: [{ peerId: created.peerId }], timeoutMs: 60000 } };
    return { text: 'Relay: ' + peerAnswer(toolText(messages, 'await_peers')) };
  });
  agents.scripts.set('Draft the release notes', () => ({ text: 'Notes drafted.' }));
  await coordinator.command({ type: 'prompt', message: 'Open a release chat' });
  const messages = await coordinator.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Notes drafted.');
  const seen = agents.model.requests.findLast(request => startedWith(request, 'Open a release chat')).messages;
  const created = toolResult(seen, 'create_peer');
  expect(created.error).toBeUndefined();
  const session = (await agents.daemon.invoke('list_sessions')).find((item: any) => item.id === created.peerId);
  expect(session).toMatchObject({ name: 'Release notes' });
  expect(session.subagentParentId).toBeUndefined();
}, 120000);

test.concurrent('branchoff_peer starts a peer in a new worktree with only the committed files, the agent and the history', async () => {
  const coordinator = await agents.rootChat({ repository: true });
  agents.scripts.set('Branch me', messages => {
    const last = text(messages.at(-1));
    if (last.includes('Continue in the branch')) return { text: 'Branch working.' };
    if (last === 'Branch me') return { text: 'Base answer.' };
    return called(messages, 'branchoff_peer') ? { text: 'Done.' } : { tool: 'branchoff_peer', arguments: { message: 'Continue in the branch' } };
  });
  await coordinator.command({ type: 'prompt', message: 'Branch me' });
  await coordinator.until(history => text(history.at(-1)) === 'Base answer.');
  writeFileSync(join(coordinator.cwd, 'README.md'), 'uncommitted\n');
  writeFileSync(join(coordinator.cwd, 'staged.txt'), 'staged\n');
  execFileSync('git', ['-C', coordinator.cwd, 'add', 'staged.txt']);
  // The coordinator commits its files when it answers, so the commit to branch from is the one before this turn.
  const baseCommit = execFileSync('git', ['-C', coordinator.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(coordinator.cwd, 'untracked.txt'), 'untracked\n');
  await coordinator.command({ type: 'prompt', message: 'Now branch off' });
  await coordinator.until(history => text(history.at(-1)) === 'Done.');
  const created = toolResult(agents.model.requests.findLast(request => called(request.messages, 'branchoff_peer')).messages, 'branchoff_peer');
  expect(Object.keys(created)).toEqual(['peerId']);
  const session = (await agents.daemon.invoke('list_sessions')).find((item: any) => item.id === created.peerId);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  expect(session.cwd).not.toBe(coordinator.cwd);
  expect(session.forkSourceId).toBe(coordinator.sessionId);
  expect(git(session.cwd, 'rev-parse', 'HEAD')).toBe(baseCommit);
  expect(git(session.cwd, 'symbolic-ref', '--short', 'HEAD')).not.toBe(git(coordinator.cwd, 'symbolic-ref', '--short', 'HEAD'));
  // Uncommitted, staged and untracked files stay in the source folder.
  expect(readFileSync(join(session.cwd, 'README.md'), 'utf8')).toBe('start\n');
  expect(existsSync(join(session.cwd, 'staged.txt'))).toBe(false);
  expect(existsSync(join(session.cwd, 'untracked.txt'))).toBe(false);
  expect(git(session.cwd, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(coordinator.cwd, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  // The peer's model sees the history through the last finished answer, then the message.
  for (const deadline = Date.now() + 60000; !agents.model.requests.some(request => text(request.messages.at(-1)).includes('Continue in the branch')) && Date.now() < deadline;) await Bun.sleep(100);
  const peerSaw = agents.model.requests.find(request => text(request.messages.at(-1)).includes('Continue in the branch')).messages.filter((message: any) => !['system', 'developer'].includes(message.role)).map(text);
  expect(peerSaw).toEqual(['Branch me', 'Base answer.', '<peer_message>\nPeer ' + (coordinator.name ?? coordinator.sessionId) + ':\nContinue in the branch\n</peer_message>']);
}, 120000);

test.concurrent('branchoff_peer removes the peer, its worktree and its branch when the first message does not arrive', async () => {
  const coordinator = await agents.rootChat({ repository: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', coordinator.cwd, ...args], { encoding: 'utf8' }).trim();
  const before = { worktrees: git('worktree', 'list'), branches: git('branch', '--list') };
  agents.scripts.set('Fail a branch', messages => {
    const last = text(messages.at(-1));
    if (last === 'Fail a branch') return { text: 'Base answer.' };
    // A message of only spaces passes the tool's schema but is refused by the daemon before delivery.
    return called(messages, 'branchoff_peer') ? { text: 'Told: ' + last } : { tool: 'branchoff_peer', arguments: { message: '   ' } };
  });
  await coordinator.command({ type: 'prompt', message: 'Fail a branch' });
  await coordinator.until(history => text(history.at(-1)) === 'Base answer.');
  await coordinator.command({ type: 'prompt', message: 'Now branch off' });
  const told = text((await coordinator.until(history => text(history.at(-1)).startsWith('Told: '))).at(-1));
  expect(told).toStartWith('Told: The peer was not created');
  expect({ worktrees: git('worktree', 'list'), branches: git('branch', '--list') }).toEqual(before);
  // Other tests make chats at the same time, so only branches of this chat count.
  expect((await agents.daemon.invoke('list_sessions')).filter((item: any) => item.forkSourceId === coordinator.sessionId)).toEqual([]);
}, 120000);

test.concurrent('branchoff_peer is offered only in a chat whose folder is a Git repository', async () => {
  const offered = async (repository: boolean, prompt: string) => {
    agents.scripts.set(prompt, () => ({ text: 'Done.' }));
    const chat = await agents.rootChat({ repository });
    await chat.command({ type: 'prompt', message: prompt });
    await chat.until(history => text(history.at(-1)) === 'Done.');
    return agents.model.requests.find(request => startedWith(request, prompt)).tools.some((tool: any) => tool.function.name === 'branchoff_peer');
  };
  expect(await offered(true, 'Check tools in a repository')).toBe(true);
  expect(await offered(false, 'Check tools outside a repository')).toBe(false);
}, 60000);

test.concurrent('create_peer starts the peer in another registered project and refuses the own or an unknown project', async () => {
  const other = join(agents.daemon.home, 'peer-target'); mkdirSync(other, { recursive: true });
  await agents.daemon.invoke('load_session_groups', { seeds: [] });
  await agents.daemon.invoke('change_session_groups', { change: { type: 'project', project: { id: 'local:' + other, name: 'Target', cwd: other, hostId: 'local', hostName: null }, key: null } });
  const coordinator = await agents.rootChat();
  await agents.daemon.invoke('change_session_groups', { change: { type: 'project', project: { id: 'local:' + coordinator.cwd, name: 'Home', cwd: coordinator.cwd, hostId: 'local', hostName: null }, key: null } });
  const attempts = [['Target', 'Project target'], ['Home', 'Project home'], ['Nowhere', 'Project nowhere']];
  agents.scripts.set('Try projects', messages => {
    const tried = messages.filter((message: any) => message.role === 'tool').length;
    if (tried < attempts.length) return { tool: 'create_peer', arguments: { title: attempts[tried][1], message: 'Hello ' + attempts[tried][0], project: attempts[tried][0] } };
    return { text: 'Done.' };
  });
  agents.scripts.set('Hello Target', () => ({ text: 'Hi.' }));
  await coordinator.command({ type: 'prompt', message: 'Try projects' });
  await coordinator.until(history => text(history.at(-1)) === 'Done.');
  const results = agents.model.requests.findLast(request => startedWith(request, 'Try projects')).messages.filter((message: any) => message.role === 'tool').map(text);
  const created = JSON.parse(results[0]);
  expect((await agents.daemon.invoke('list_sessions')).find((item: any) => item.id === created.peerId).cwd).toBe(other);
  expect(results.slice(1)).toEqual(['Home is your own project; omit project to use it', 'Piop has no project named Nowhere']);
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
    if (!called(messages, 'stop_peer')) return { tool: 'stop_peer', arguments: { peerId: worker.sessionId } };
    if (!called(messages, 'message_peer')) return { tool: 'message_peer', arguments: { peerId: worker.sessionId, message: 'Are you still there?' } };
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
  agents.scripts.set('Ask the busy worker', messages => called(messages, 'message_peer')
    ? { text: 'Relay: ' + JSON.stringify(toolResult(messages, 'message_peer')) }
    : { tool: 'message_peer', arguments: { peerId: worker.sessionId, message: 'Queued question' } });
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
  agents.scripts.set('Message myself', messages => called(messages, 'message_peer') ? { text: 'Told: ' + text(messages.at(-1)) } : { tool: 'message_peer', arguments: { peerId: chat.sessionId, message: 'Hello me' } });
  await chat.command({ type: 'prompt', message: 'Message myself' });
  const history = await chat.until(messages => text(messages.at(-1)).startsWith('Told: '));
  expect(text(history.at(-1))).toBe('Told: Choose another conversation as the recipient');
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled');
  expect((await chat.command({ type: 'get_state' })).pendingMessageCount).toBe(0);
  expect((await chat.history()).filter(message => message.role === 'user').map(text)).toEqual(['Message myself']);
}, 60000);

test.concurrent('messaging or waiting for a chat that does not exist tells the agent so in plain words', async () => {
  const missing = '11111111-2222-3333-4444-555555555555';
  agents.scripts.set('Message a missing chat', messages => called(messages, 'message_peer') ? { text: 'Told: ' + text(messages.at(-1)) } : { tool: 'message_peer', arguments: { peerId: missing, message: 'Hello?' } });
  agents.scripts.set('Wait for a missing chat', messages => called(messages, 'await_peers') ? { text: 'Told: ' + text(messages.at(-1)) } : { tool: 'await_peers', arguments: { targets: [{ peerId: missing }], timeoutMs: 2000 } });
  const sender = await agents.rootChat();
  await sender.command({ type: 'prompt', message: 'Message a missing chat' });
  expect(text((await sender.until(messages => text(messages.at(-1)).startsWith('Told: '))).at(-1))).toBe('Told: Conversation was not found in active or archived storage');
  const waiter = await agents.rootChat();
  await waiter.command({ type: 'prompt', message: 'Wait for a missing chat' });
  const told = text((await waiter.until(messages => text(messages.at(-1)).startsWith('Told: '))).at(-1));
  expect(told).toBe('Told: Peer ' + missing + ': Conversation was not found in active or archived storage');
}, 60000);

test('list_agent_profiles follows the tool groups and lists the descriptions of agents that can start', async () => {
  const setup = await agents.rootChat();
  const setTools = async (tools: string[]) => {
    const configuration = await setup.command({ type: 'get_agent_configuration' });
    const general = configuration.agents.find((agent: any) => agent.name === 'general');
    const helper = { ...general, name: 'helper', isDefault: undefined, description: 'Finds files.', allow_as_peer: false, tools: ['read'] };
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

  await setTools(['read', 'create_peer']);
  const peers = await listed('List peer agents', {});
  expect(peers.tool.parameters.properties).toEqual({});
  // helper is not usable as a peer.
  expect(JSON.parse(peers.answer).map((profile: any) => profile.name)).not.toContain('helper');

  await setTools(['read', 'spawn_subagents', 'create_peer']);
  const both = await listed('List subagent agents', { for: 'subagent' });
  expect(both.tool.parameters.required).toEqual(['for']);
  expect(JSON.parse(both.answer).find((profile: any) => profile.name === 'helper')).toEqual({ name: 'helper', description: 'Finds files.' });

  await setTools(['read']);
  agents.scripts.set('No agent tools', () => ({ text: 'Done' }));
  const plain = await agents.rootChat();
  await plain.command({ type: 'prompt', message: 'No agent tools' });
  await plain.until(messages => text(messages.at(-1)) === 'Done');
  expect(profilesTool('No agent tools')).toBeUndefined();
}, 120000);
