import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';
import { stoppedJob } from './stopped-job';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); await agents.enableAgentTools('spawn_subagents'); }, 60000);
afterAll(async () => { await agents?.close(); });
const jobs: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of jobs.splice(0)) await close(); });

test.concurrent('a child agent\'s final answer reaches its parent, which continues with it', async () => {
  agents.scripts.set('Read the README for me', messages => {
    const last = messages.at(-1);
    if (last.role === 'user' && text(last).includes('Read the README for me')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Reader', task: 'Summarize the README' }] } };
    const delivered = text(last).match(/README is about \w+/);
    return { text: delivered ? 'The reader says: ' + delivered[0] : 'Waiting for the reader.' };
  });
  agents.scripts.set('Summarize the README', () => ({ text: 'The README is about cats.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Read the README for me' });
  const messages = await root.until(history => history.some(message => message.role === 'assistant' && text(message).startsWith('The reader says')));
  expect(text(messages.findLast(message => message.role === 'assistant'))).toBe('The reader says: README is about cats');
  // The child sees only the text its parent wrote, as a plain user message.
  const childRequest = agents.model.requests.find(request => text(request.messages.find((message: any) => message.role === 'user')) === 'Summarize the README');
  expect(childRequest.messages.filter((message: any) => message.role !== 'system').map((message: any) => [message.role, text(message)])).toEqual([['user', 'Summarize the README']]);
  const sessions = await agents.daemon.invoke('list_sessions');
  const child = sessions.find((session: any) => session.subagentParentId === root.sessionId);
  expect(child).toMatchObject({ name: 'Subagent: Reader' });
  await agents.daemon.invoke('start_pi', { runtimeId: 'subagent-fork-check', clientId: 'laptop', cwd: root.cwd, sessionPath: child.path });
  const childCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'subagent-fork-check', command });
  expect((await childCommand({ type: 'get_state' })).canFork).toBe(false);
  expect((await childCommand({ type: 'get_snapshot' })).state.canFork).toBe(false);
  for (const type of ['copy_after', 'fork_after', 'fork', 'clone', 'fork_and_forget']) {
    await expect(childCommand({ type, entryId: 'any-response' })).rejects.toThrow('Only main chats can be forked');
  }

  // The chat view lists delegated work from this message; it needs these fields for each run.
  const delivered = (await root.command({ type: 'get_entries' })).entries.find((entry: any) => entry.customType === 'piop-subagent-result');
  expect(delivered.details.runs).toEqual([expect.objectContaining({ name: 'Reader', task: 'Summarize the README', status: 'completed', sessionId: child.id, sessionPath: child.path, hostId: 'local' })]);
  const db = new Database(join(agents.daemon.home, '.piop', 'sessions.sqlite'), { readonly: true });
  try {
    const records = db.query('SELECT entry_json FROM session_extension_records WHERE session_id IN (?, ?)').all(root.sessionId, child.id) as { entry_json: string }[];
    expect(records.map(row => JSON.parse(row.entry_json).customType).filter(type => /^piop-subagent-.*usage$/.test(type))).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='session_usage_channels'").all()).toEqual([]);
    const rows = db.query('SELECT run_json FROM session_subagent_runs WHERE session_id=?').all(root.sessionId) as { run_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const { run_json } of rows) {
      const run = JSON.parse(run_json);
      for (const field of ['accountedTokens', 'forwardedTokens', 'accountingPending', 'sourceTotals', 'apiCost', 'offset']) expect(run).not.toHaveProperty(field);
    }
  } finally { db.close(); }

}, 120000);

/** An agent that delegates task to a child named name, then answers with what the child delivered. */
const delegating = (name: string, task: string) => (messages: any[]) => {
  const last = messages.at(-1);
  if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: name, task: task }] } };
  const delivered = text(last).match(/Relay: [^"\\\n]*/);
  return { text: delivered ? delivered[0] : 'Waiting for ' + name + '.' };
};

test.concurrent('a grandchild cannot start its own child, and its parents hear why', async () => {
  agents.scripts.set('Start a chain', delegating('Child', 'Delegate further'));
  agents.scripts.set('Delegate further', delegating('Grandkid', 'Delegate once more'));
  agents.scripts.set('Delegate once more', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Toodeep', task: 'Unreachable task' }] } };
    return { text: 'Relay: ' + text(last) };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Start a chain' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Delegation is limited to two levels: root → child → grandchild. Return your findings to the parent.');
  expect(agents.model.requests.some(request => JSON.stringify(request.messages).includes('Unreachable task') && !JSON.stringify(request.messages).includes('Delegate once more'))).toBe(false);
}, 120000);

for (const delivery of ['steer', 'follow_up']) test.concurrent('a message to a busy child arrives ' + (delivery === 'steer' ? 'before its next model call when steered' : 'after its current work as a follow-up'), async () => {
  const prompt = 'Busy helper ' + delivery, task = 'Steerable job ' + delivery;
  const firstReply = Promise.withResolvers<any>();
  agents.scripts.set(prompt, messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Busy', task }] } };
    if (last === 'Change the plan' && !called(messages, 'message_subagent')) return { tool: 'message_subagent', arguments: { nickname: 'Busy', message: 'Change of plan', delivery } };
    const relay = last.match(/Relay: [\w ]+/);
    return { text: relay ? relay[0] : 'Waiting.' };
  });
  agents.scripts.set(task, messages => {
    if (!called(messages, 'bash')) return firstReply.promise;
    if (text(messages.at(-1)).includes('Change of plan')) return { text: JSON.stringify(messages).includes('First task done.') ? 'Relay: followed up' : 'Relay: steered early' };
    return { text: 'First task done.' };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: prompt });
  await root.until(() => agents.model.requests.some(request => JSON.stringify(request.messages).includes(task)));
  await root.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'spawn_subagents'));
  await root.command({ type: 'follow_up', message: 'Change the plan' });
  await root.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'message_subagent'));
  firstReply.resolve({ tool: 'bash', arguments: { command: 'true' } });
  const messages = await root.until(history => /Relay: (steered early|followed up)/.test(text(history.at(-1))));
  expect(text(messages.at(-1))).toBe(delivery === 'steer' ? 'Relay: steered early' : 'Relay: followed up');
}, 120000);

test.concurrent('a follow-up task goes to the same child, which still remembers its earlier work', async () => {
  agents.scripts.set('Use a memory helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Memory', task: 'Remember the word apple' }] } };
    if (last.includes('Relay: remembered') && !called(messages, 'message_subagent')) return { tool: 'message_subagent', arguments: { nickname: 'Memory', message: 'Which word did I give you?' } };
    const answer = last.match(/Relay: word is \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  agents.scripts.set('Remember the word apple', messages => {
    const asked = text(messages.at(-1)).includes('Which word did I give you?');
    const remembered = JSON.stringify(messages).match(/Remember the word (\w+)/)?.[1];
    return { text: asked ? 'Relay: word is ' + remembered : 'Relay: remembered' };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Use a memory helper' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: word is'));
  expect(text(messages.at(-1))).toBe('Relay: word is apple');
  const children = (await agents.daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId);
  expect(children.map((child: any) => child.name)).toEqual(['Subagent: Memory']);
}, 120000);

test('a child paused by a model failure is reported to its parent at once and can still take a follow-up', async () => {
  agents.scripts.set('Ask a flaky helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Flaky', task: 'Flaky task' }] } };
    if (last.includes('model overloaded') && !called(messages, 'message_subagent')) return { tool: 'message_subagent', arguments: { nickname: 'Flaky', message: 'Try again' } };
    const answer = last.match(/Relay: \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  agents.scripts.set('Flaky task', messages => {
    if (!JSON.stringify(messages).includes('Try again')) throw new Error('model overloaded');
    return { text: 'Relay: recovered' };
  });
  const root = await agents.rootChat();
  const started = Date.now();
  await root.command({ type: 'prompt', message: 'Ask a flaky helper' });
  await root.until(history => history.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'message_subagent')));
  expect(Date.now() - started).toBeLessThan(30000);
  await root.until(history => text(history.at(-1)) === 'Relay: recovered');
  const rootRequests = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Ask a flaky helper'));
  expect(rootRequests.some(request => /<subagent_response>\n[\s\S]*model overloaded/.test(text(request.messages.at(-1))))).toBe(true);
}, 120000);

test.concurrent('interrupting a busy child cancels its work, tells the parent, and the child takes a follow-up', async () => {
  let releaseSlow!: (reply: { text: string }) => void;
  const slowReply = new Promise<{ text: string }>(resolve => { releaseSlow = resolve; });
  agents.scripts.set('Start a slow helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Slow', task: 'Slow task' }] } };
    if (last.includes('Stop the slow helper')) return { tool: 'stop_subagent', arguments: { nickname: 'Slow' } };
    if (last.includes('stopped by stop_subagent')) return { tool: 'message_subagent', arguments: { nickname: 'Slow', message: 'Quick task' } };
    const answer = last.match(/Relay: \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  agents.scripts.set('Slow task', () => slowReply);
  agents.scripts.set('Quick task', () => ({ text: 'Relay: quick' }));
  const root = await agents.rootChat();
  try {
    await root.command({ type: 'prompt', message: 'Start a slow helper' });
    await root.until(() => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Slow task')));
    await root.command({ type: 'prompt', message: 'Stop the slow helper' });
    await root.until(history => text(history.at(-1)) === 'Relay: quick');
  } finally { releaseSlow({ text: 'Relay: late' }); }
  const rootRequests = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Start a slow helper'));
  expect(rootRequests.some(request => /<subagent_response>\n[\s\S]*Subagent stopped by stop_subagent/.test(text(request.messages.at(-1))))).toBe(true);
  expect((await agents.daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId).length).toBe(1);
}, 120000);

test.concurrent('a parent sees its busy child in its agent list and can send the child an update it acts on', async () => {
  let releaseFirst!: (reply: { text: string }) => void;
  const firstReply = new Promise<{ text: string }>(resolve => { releaseFirst = resolve; });
  const toolResult = (messages: any[], tool: string) => {
    const call = messages.findLast(message => message.tool_calls?.some((item: any) => item.function.name === tool))?.tool_calls.find((item: any) => item.function.name === tool);
    return call && text(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id));
  };
  agents.scripts.set('Delegate to a worker', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Worker', task: 'Build the feature' }] } };
    if (text(last).includes('Check on the worker') && !called(messages, 'list_subagents')) return { tool: 'list_subagents' };
    if (last.role === 'tool' && called(messages, 'list_subagents') && !called(messages, 'message_subagent')) return { tool: 'message_subagent', arguments: { nickname: 'Worker', message: 'Also check the tests' } };
    return { text: 'Waiting.' };
  });
  agents.scripts.set('Build the feature', messages => JSON.stringify(messages).includes('Also check the tests') ? { text: 'Tests checked.' } : firstReply);
  const root = await agents.rootChat();
  try {
    await root.command({ type: 'prompt', message: 'Delegate to a worker' });
    await root.until(() => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Build the feature') && !JSON.stringify(request.messages).includes('Delegate to a worker')));
    await root.command({ type: 'prompt', message: 'Check on the worker' });
    await root.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'message_subagent'));
  } finally { releaseFirst({ text: 'Feature built.' }); }
  const rootSeen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Delegate to a worker') && called(request.messages, 'message_subagent')).messages;
  const listed = JSON.parse(toolResult(rootSeen, 'list_subagents'));
  expect(listed).toEqual([expect.objectContaining({ nickname: "Worker", status: 'running' })]);
  expect(JSON.parse(toolResult(rootSeen, 'message_subagent'))).toMatchObject({ accepted: true });
  for (let tries = 0; tries < 100 && !agents.model.requests.some(request => JSON.stringify(request.messages).includes('Also check the tests') && !JSON.stringify(request.messages).includes('Delegate to a worker')); tries++) await Bun.sleep(100);
  const childSaw = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Build the feature') && !JSON.stringify(request.messages).includes('Delegate to a worker'));
  expect(JSON.stringify(childSaw.at(-1).messages)).toContain('Also check the tests');
  expect(JSON.stringify(childSaw.at(-1).messages)).toContain('Feature built.');
}, 120000);

test.concurrent('a batch of children runs at once, waiting for all ends only after each answered, and every answer reaches the parent', async () => {
  const answered = new Map<string, number>();
  const started = new Set<string>();
  const bothStarted = Promise.withResolvers<void>();
  let order = 0;
  agents.scripts.set('Count the fruit', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Apples', task: 'Count apples' }, { nickname: 'Pears', task: 'Count pears' }] } };
    if (!called(messages, 'await_subagents')) return { tool: 'await_subagents', arguments: { for: 'all' } };
    if (last.role === 'tool' && !answered.has('awaited')) answered.set('awaited', ++order);
    const counts = JSON.stringify(messages).match(/Relay: \d+ \w+/g) ?? [];
    return { text: counts.length ? 'Counts: ' + [...new Set(counts)].sort().join(', ') : 'Waiting.' };
  });
  for (const [task, answer] of [['Count apples', 'Relay: 3 apples'], ['Count pears', 'Relay: 5 pears']]) {
    agents.scripts.set(task, async () => {
      started.add(task);
      if (started.size === 2) bothStarted.resolve();
      await bothStarted.promise;
      answered.set(task, ++order);
      return { text: answer };
    });
  }
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Count the fruit' });
  await root.until(history => text(history.at(-1)) === 'Counts: Relay: 3 apples, Relay: 5 pears');
  expect(answered.get('awaited')).toBeGreaterThan(Math.max(answered.get('Count apples')!, answered.get('Count pears')!));
  // await_subagents returns both answers itself, and they are not sent again as messages.
  const seen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Count the fruit')).messages;
  const waited = seen.find((message: any) => message.role === 'tool' && /Relay: 3 apples/.test(text(message)));
  expect(text(waited)).toMatch(/<subagent_response>\nSubagent (Apples|Pears):[\s\S]*<subagent_response>\nSubagent (Apples|Pears):/);
  expect(seen.filter((message: any) => message.role === 'user' && text(message).includes('<subagent_response>'))).toEqual([]);
  const children = (await agents.daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId).map((session: any) => session.name).sort();
  expect(children).toEqual(['Subagent: Apples', 'Subagent: Pears']);
}, 120000);

test.concurrent('awaiting any subagent returns when the first one finishes, while the other keeps running', async () => {
  const slow = Promise.withResolvers<{ text: string }>();
  agents.scripts.set('Race two helpers', messages => {
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Quick', task: 'Quick race job' }, { nickname: 'Slowpoke', task: 'Slow race job' }] } };
    if (!called(messages, 'await_subagents')) return { tool: 'await_subagents' };
    return { text: 'Got: ' + text(messages.at(-1)) };
  });
  agents.scripts.set('Quick race job', () => ({ text: 'Quick done.' }));
  agents.scripts.set('Slow race job', () => slow.promise);
  const root = await agents.rootChat();
  try {
    await root.command({ type: 'prompt', message: 'Race two helpers' });
    const messages = await root.until(history => text(history.at(-1)).startsWith('Got: '));
    expect(text(messages.at(-1))).toBe('Got: <subagent_response>\nSubagent Quick:\nQuick done.\n</subagent_response>\n\nOther subagents are still running.');
  } finally { slow.resolve({ text: 'Slow done.' }); }
}, 120000);

test('an agent limited to one subagent cannot start a second while the first is still working', async () => {
  const setup = await agents.rootChat();
  const original = await setup.command({ type: 'get_agent_configuration' });
  const setLimit = async (limit?: number) => {
    const current = await setup.command({ type: 'get_agent_configuration' });
    await setup.command({ type: 'configure_agents', configuration: { revision: current.revision, agents: original.agents.map((agent: any) => limit === undefined ? agent : { ...agent, max_subagents: limit }) } });
  };
  let releaseFirst!: (reply: { text: string }) => void;
  const firstReply = new Promise<{ text: string }>(resolve => { releaseFirst = resolve; });
  agents.scripts.set('Use one helper', messages => {
    const last = messages.at(-1);
    const spawns = messages.filter((message: any) => message.tool_calls?.some((call: any) => call.function.name === 'spawn_subagents')).length;
    if (spawns === 0) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'One', task: 'Limited first task' }, { nickname: 'Two', task: 'Limited second task' }] } };
    if (spawns === 1 && last.role === 'tool') return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'First', task: 'Limited first task' }] } };
    if (spawns === 2 && last.role === 'tool') return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Second', task: 'Limited second task' }] } };
    return { text: 'Done trying.' };
  });
  agents.scripts.set('Limited first task', () => firstReply);
  await setLimit(1);
  try {
    const root = await agents.rootChat();
    await root.command({ type: 'prompt', message: 'Use one helper' });
    const messages = await root.until(history => text(history.at(-1)) === 'Done trying.');
    const results = messages.filter(message => message.role === 'toolResult').map(message => [message.toolName, message.isError]);
    expect(results).toEqual([['spawn_subagents', true], ['spawn_subagents', false], ['spawn_subagents', true]]);
    const seen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Use one helper')).messages.filter((message: any) => message.role === 'tool').map(text);
    expect(seen[0]).toBe('This agent allows at most 1 concurrent subagents; 0 slots are occupied');
    expect(seen[2]).toBe('This agent allows at most 1 concurrent subagents; 1 slots are occupied');
  } finally { releaseFirst({ text: 'First done.' }); await setLimit(); }
}, 120000);

test('waiting for subagents ends early when the user sends a new message, which is handled next', async () => {
  let releaseChild!: (reply: { text: string }) => void;
  const childReply = new Promise<{ text: string }>(resolve => { releaseChild = resolve; });
  agents.scripts.set('Wait for news', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Sleeper', task: 'Sleep a while' }] } };
    if (!called(messages, 'await_subagents')) return { tool: 'await_subagents' };
    if (last.role === 'tool') return { text: 'Wait ended: ' + text(last) };
    return { text: 'Handled: ' + text(last) };
  });
  agents.scripts.set('Sleep a while', () => childReply);
  const root = await agents.rootChat();
  try {
    await root.command({ type: 'prompt', message: 'Wait for news' });
    await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === root.runtimeId
      && payload.event?.type === 'tool_execution_start' && payload.event.toolName === 'await_subagents');
    const sent = Date.now();
    await root.command({ type: 'follow_up', message: 'Here is the news' });
    const messages = await root.until(history => text(history.at(-1)) === 'Handled: Here is the news');
    expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Wait ended: The user sent a new message. Subagents are still running.', 'Handled: Here is the news']);
    expect(Date.now() - sent).toBeLessThan(8000);
  } finally { releaseChild({ text: 'Slept.' }); }
}, 120000);

test('archiving a parent while its child runs a command ends the child\'s command and the child makes no more model calls', async () => {
  const job = await stoppedJob('child-late.txt', jobs);
  agents.scripts.set('Delegate a slow job', messages => called(messages, 'spawn_subagents') ? { text: 'Waiting.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Slow', task: 'Slow child job' }] } });
  agents.scripts.set('Slow child job', messages => called(messages, 'bash') ? { text: 'Child done.' } : { tool: 'bash', arguments: { command: job.command } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Delegate a slow job' });
  await job.started();
  const { sessionFile } = await root.command({ type: 'get_state' });
  await agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath: sessionFile, terminalIds: [], clientId: 'laptop' });
  const calls = agents.model.requests.length;
  await job.stopped();
  expect(existsSync(join(root.cwd, 'child-late.txt'))).toBe(false);
  expect(agents.model.requests.length).toBe(calls);
}, 60000);

test('stopping a parent that waits for its child stops both at once, and the parent makes no more model calls', async () => {
  const job = await stoppedJob('patient-late.txt', jobs);
  agents.scripts.set('Wait for a slow child', messages => called(messages, 'await_subagents') ? { text: 'Kept going after stop.' }
    : called(messages, 'spawn_subagents') ? { tool: 'await_subagents' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Patient', task: 'Patient child job' }] } });
  agents.scripts.set('Patient child job', messages => called(messages, 'bash') ? { text: 'Child done.' } : { tool: 'bash', arguments: { command: job.command } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Wait for a slow child' });
  await job.started();
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === root.runtimeId
    && payload.event?.type === 'tool_execution_start' && payload.event.toolName === 'await_subagents');
  const calls = agents.model.requests.length;
  await root.command({ type: 'abort' });
  await job.stopped();
  expect(existsSync(join(root.cwd, 'patient-late.txt'))).toBe(false);
  expect(agents.model.requests.length).toBe(calls);
  expect((await root.history()).some(message => text(message) === 'Kept going after stop.')).toBe(false);
}, 60000);

test('pausing a parent cancels its busy child, and after resume the parent hears of it and the child takes the task again', async () => {
  const job = await stoppedJob('paused-late.txt', jobs);
  agents.scripts.set('Pause while a child works', messages => {
    const last = text(messages.at(-1));
    const relay = last.match(/Relay: \w+/);
    if (relay) return { text: relay[0] };
    if (last.startsWith('<subagent_response>\nSubagent Patience:') && !called(messages, 'message_subagent')) return { tool: 'message_subagent', arguments: { nickname: 'Patience', message: 'Try the slow job again' } };
    if (called(messages, 'spawn_subagents') && !called(messages, 'await_subagents')) return { tool: 'await_subagents' };
    return called(messages, 'spawn_subagents') ? { text: 'Waiting.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Patience', task: 'Paused child job' }] } };
  });
  agents.scripts.set('Paused child job', messages => JSON.stringify(messages).includes('Try the slow job again') ? { text: 'Relay: retried' }
    : called(messages, 'bash') ? { text: 'Relay: first' } : { tool: 'bash', arguments: { command: job.command } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Pause while a child works' });
  await job.started();
  await root.command({ type: 'pause' });
  await job.stopped();
  await root.until(history => history.at(-1)?.stopReason === 'aborted');
  await root.command({ type: 'resume' });
  const messages = await root.until(history => text(history.at(-1)) === 'Relay: retried');
  expect(messages.some(message => text(message) === 'Relay: first')).toBe(false);
  expect(messages.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'message_subagent'))).toBe(true);
}, 90000);

test('deleting a parent while its child runs a command stops the child and deletes both chats', async () => {
  const job = await stoppedJob('doomed-late.txt', jobs);
  agents.scripts.set('Delegate a doomed job', messages => called(messages, 'spawn_subagents') ? { text: 'Waiting.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Doomed', task: 'Doomed child job' }] } });
  agents.scripts.set('Doomed child job', messages => called(messages, 'bash') ? { text: 'Child done.' } : { tool: 'bash', arguments: { command: job.command } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Delegate a doomed job' });
  await job.started();
  const { sessionFile } = await root.command({ type: 'get_state' });
  const deleted = await agents.daemon.invoke('delete_session', { hostId: 'local', sessionPath: sessionFile, clientId: 'laptop' });
  expect(deleted).toHaveLength(2);
  const calls = agents.model.requests.length;
  await job.stopped();
  expect(existsSync(join(root.cwd, 'doomed-late.txt'))).toBe(false);
  expect(agents.model.requests.length).toBe(calls);
  const listed = (await agents.daemon.invoke('list_sessions')).map((session: any) => session.path);
  expect(deleted.some((path: string) => listed.includes(path))).toBe(false);
}, 60000);
