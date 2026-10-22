import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test('a child agent\'s final answer reaches its parent, which continues with it', async () => {
  agents.scripts.set('Read the README for me', messages => {
    const last = messages.at(-1);
    if (last.role === 'user' && text(last).includes('Read the README for me')) return { tool: 'spawn_agent', arguments: { task_name: 'reader', message: 'Summarize the README' } };
    const delivered = text(last).match(/README is about \w+/);
    return { text: delivered ? 'The reader says: ' + delivered[0] : 'Waiting for the reader.' };
  });
  agents.scripts.set('Summarize the README', () => ({ text: 'The README is about cats.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Read the README for me' });
  const messages = await root.until(history => history.some(message => message.role === 'assistant' && text(message).startsWith('The reader says')));
  expect(text(messages.findLast(message => message.role === 'assistant'))).toBe('The reader says: README is about cats');
  const sessions = await agents.daemon.invoke('list_sessions');
  const child = sessions.find((session: any) => session.subagentParentId === root.sessionId);
  expect(child).toMatchObject({ name: 'Subagent: reader' });
  await agents.daemon.invoke('start_pi', { runtimeId: 'subagent-fork-check', clientId: 'laptop', cwd: root.cwd, sessionPath: child.path });
  const childCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'subagent-fork-check', command });
  expect((await childCommand({ type: 'get_state' })).canFork).toBe(false);
  expect((await childCommand({ type: 'get_snapshot' })).state.canFork).toBe(false);
  for (const type of ['copy_after', 'fork_after', 'fork', 'clone', 'fork_and_forget']) {
    await expect(childCommand({ type, entryId: 'any-response' })).rejects.toThrow('Only main chats can be forked');
  }

  // The chat view lists delegated work from this message; it needs these fields for each run.
  const delivered = (await root.command({ type: 'get_entries' })).entries.find((entry: any) => entry.customType === 'piop-subagent-result');
  expect(delivered.details.runs).toEqual([expect.objectContaining({ name: 'reader', task: 'Summarize the README', status: 'completed', sessionId: child.id, sessionPath: child.path, hostId: 'local' })]);
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
  if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: name, message: task } };
  const delivered = text(last).match(/Relay: [^"\\]*/);
  return { text: delivered ? delivered[0] : 'Waiting for ' + name + '.' };
};

test('a grandchild cannot start its own child, and its parents hear why', async () => {
  agents.scripts.set('Start a chain', delegating('child', 'Delegate further'));
  agents.scripts.set('Delegate further', delegating('grandchild', 'Delegate once more'));
  agents.scripts.set('Delegate once more', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'too_deep', message: 'Unreachable task' } };
    return { text: 'Relay: ' + text(last) };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Start a chain' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Delegation is limited to two levels: root → child → grandchild. Return your findings to the parent.');
  expect(agents.model.requests.some(request => JSON.stringify(request.messages).includes('Unreachable task') && !JSON.stringify(request.messages).includes('Delegate once more'))).toBe(false);
}, 120000);

test('a follow-up task goes to the same child, which still remembers its earlier work', async () => {
  agents.scripts.set('Use a memory helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'memory', message: 'Remember the word apple' } };
    if (last.includes('Relay: remembered') && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'memory', message: 'Which word did I give you?' } };
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
  expect(children.map((child: any) => child.name)).toEqual(['Subagent: memory']);
}, 120000);

test('a child paused by a model failure is reported to its parent at once and can still take a follow-up', async () => {
  agents.scripts.set('Ask a flaky helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'flaky', message: 'Flaky task' } };
    if (last.includes('model overloaded') && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'flaky', message: 'Try again' } };
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
  await root.until(history => history.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'followup_task')));
  expect(Date.now() - started).toBeLessThan(30000);
  await root.until(history => text(history.at(-1)) === 'Relay: recovered');
  const rootRequests = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Ask a flaky helper'));
  expect(rootRequests.some(request => /failed[\s\S]*model overloaded/.test(JSON.stringify(request.messages.at(-1))))).toBe(true);
}, 120000);

test('interrupting a busy child cancels its work, tells the parent, and the child takes a follow-up', async () => {
  let releaseSlow!: (reply: { text: string }) => void;
  const slowReply = new Promise<{ text: string }>(resolve => { releaseSlow = resolve; });
  agents.scripts.set('Start a slow helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'slow', message: 'Slow task' } };
    if (last.includes('Stop the slow helper')) return { tool: 'interrupt_agent', arguments: { target: 'slow' } };
    if (last.includes('stopped by interrupt_agent')) return { tool: 'followup_task', arguments: { target: 'slow', message: 'Quick task' } };
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
  expect(rootRequests.some(request => /slow: cancelled[\s\S]*Subagent stopped by interrupt_agent/.test(text(request.messages.at(-1))))).toBe(true);
  expect((await agents.daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId).length).toBe(1);
}, 120000);

test('a parent sees its busy child in its agent list and can send the child an update it acts on', async () => {
  let releaseFirst!: (reply: { text: string }) => void;
  const firstReply = new Promise<{ text: string }>(resolve => { releaseFirst = resolve; });
  const toolResult = (messages: any[], tool: string) => {
    const call = messages.findLast(message => message.tool_calls?.some((item: any) => item.function.name === tool))?.tool_calls.find((item: any) => item.function.name === tool);
    return call && text(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id));
  };
  agents.scripts.set('Delegate to a worker', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'worker', message: 'Build the feature' } };
    if (text(last).includes('Check on the worker') && !called(messages, 'list_agents')) return { tool: 'list_agents' };
    if (last.role === 'tool' && called(messages, 'list_agents') && !called(messages, 'send_message')) return { tool: 'send_message', arguments: { target: 'worker', message: 'Also check the tests' } };
    return { text: 'Waiting.' };
  });
  agents.scripts.set('Build the feature', messages => JSON.stringify(messages).includes('Also check the tests') ? { text: 'Tests checked.' } : firstReply);
  const root = await agents.rootChat();
  try {
    await root.command({ type: 'prompt', message: 'Delegate to a worker' });
    await root.until(() => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Build the feature') && !JSON.stringify(request.messages).includes('Delegate to a worker')));
    await root.command({ type: 'prompt', message: 'Check on the worker' });
    await root.until(history => history.some(message => message.role === 'toolResult' && message.toolName === 'send_message'));
  } finally { releaseFirst({ text: 'Feature built.' }); }
  const rootSeen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Delegate to a worker') && called(request.messages, 'send_message')).messages;
  const listed = JSON.parse(toolResult(rootSeen, 'list_agents'));
  expect(listed).toEqual([expect.objectContaining({ task_name: expect.stringMatching(/worker$/), status: 'running' })]);
  expect(JSON.parse(toolResult(rootSeen, 'send_message'))).toMatchObject({ accepted: true });
  for (let tries = 0; tries < 100 && !agents.model.requests.some(request => JSON.stringify(request.messages).includes('Also check the tests') && !JSON.stringify(request.messages).includes('Delegate to a worker')); tries++) await Bun.sleep(100);
  const childSaw = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Build the feature') && !JSON.stringify(request.messages).includes('Delegate to a worker'));
  expect(JSON.stringify(childSaw.at(-1).messages)).toContain('Also check the tests');
  expect(JSON.stringify(childSaw.at(-1).messages)).toContain('Feature built.');
}, 120000);

test('a child can send its parent a progress update before its final answer', async () => {
  agents.scripts.set('Run a long survey', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'surveyor', message: 'Survey the modules' } };
    if (last.includes('Halfway through the modules')) return { text: 'Noted the progress.' };
    const answer = last.match(/Relay: \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  agents.scripts.set('Survey the modules', messages => called(messages, 'send_message') ? { text: 'Relay: surveyed' } : { tool: 'send_message', arguments: { target: 'parent', message: 'Halfway through the modules' } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Run a long survey' });
  const messages = await root.until(history => text(history.at(-1)) === 'Relay: surveyed');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Waiting.', 'Noted the progress.', 'Relay: surveyed']);
}, 120000);

test('a batch of children runs at once, waiting for all ends only after each answered, and every answer reaches the parent', async () => {
  const answered = new Map<string, number>();
  agents.scripts.set('Count the fruit', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'subagent')) return { tool: 'subagent', arguments: { tasks: [{ name: 'apples', task: 'Count apples' }, { name: 'pears', task: 'Count pears' }] } };
    if (!called(messages, 'await_subagents')) return { tool: 'await_subagents' };
    if (last.role === 'tool' && !answered.has('awaited')) answered.set('awaited', Date.now());
    const counts = JSON.stringify(messages).match(/Relay: \d+ \w+/g) ?? [];
    return { text: counts.length ? 'Counts: ' + [...new Set(counts)].sort().join(', ') : 'Waiting.' };
  });
  for (const [task, answer] of [['Count apples', 'Relay: 3 apples'], ['Count pears', 'Relay: 5 pears']]) {
    agents.scripts.set(task, async () => { await Bun.sleep(300); answered.set(task, Date.now()); return { text: answer }; });
  }
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Count the fruit' });
  await root.until(history => text(history.at(-1)) === 'Counts: Relay: 3 apples, Relay: 5 pears');
  expect(answered.get('awaited')).toBeGreaterThan(Math.max(answered.get('Count apples')!, answered.get('Count pears')!));
  const children = (await agents.daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId).map((session: any) => session.name).sort();
  expect(children).toEqual(['Subagent: apples', 'Subagent: pears']);
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
    if (!called(messages, 'subagent')) return { tool: 'subagent', arguments: { tasks: [{ name: 'one', task: 'Limited first task' }, { name: 'two', task: 'Limited second task' }] } };
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'first', message: 'Limited first task' } };
    if (called(messages, 'spawn_agent') && messages.filter((message: any) => message.tool_calls?.some((call: any) => call.function.name === 'spawn_agent')).length < 2 && last.role === 'tool') return { tool: 'spawn_agent', arguments: { task_name: 'second', message: 'Limited second task' } };
    return { text: 'Done trying.' };
  });
  agents.scripts.set('Limited first task', () => firstReply);
  await setLimit(1);
  try {
    const root = await agents.rootChat();
    await root.command({ type: 'prompt', message: 'Use one helper' });
    const messages = await root.until(history => text(history.at(-1)) === 'Done trying.');
    const results = messages.filter(message => message.role === 'toolResult').map(message => [message.toolName, message.isError]);
    expect(results).toEqual([['subagent', true], ['spawn_agent', false], ['spawn_agent', true]]);
    const seen = agents.model.requests.findLast(request => JSON.stringify(request.messages).includes('Use one helper')).messages.filter((message: any) => message.role === 'tool').map(text);
    expect(seen[0]).toBe('This agent allows at most 1 concurrent subagents; 0 slots are occupied');
    expect(seen[2]).toBe('This agent allows at most 1 concurrent subagents; 1 slots are occupied');
  } finally { releaseFirst({ text: 'First done.' }); await setLimit(); }
}, 120000);

test('waiting for subagents ends early when the user sends a new message, which is handled next', async () => {
  agents.scripts.set('Wait for news', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'wait_agent')) return { tool: 'wait_agent', arguments: { timeout_ms: 60000 } };
    if (last.role === 'tool') return { text: 'Wait ended: ' + text(last) };
    return { text: 'Handled: ' + text(last) };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Wait for news' });
  await root.until(history => history.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'wait_agent')));
  await Bun.sleep(2000);
  const sent = Date.now();
  await root.command({ type: 'follow_up', message: 'Here is the news' });
  const messages = await root.until(history => text(history.at(-1)) === 'Handled: Here is the news');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Wait ended: Wait interrupted by new input.', 'Handled: Here is the news']);
  expect(Date.now() - sent).toBeLessThan(8000);
}, 120000);

test('archiving a parent while its child runs a command ends the child\'s command and the child makes no more model calls', async () => {
  agents.scripts.set('Delegate a slow job', messages => called(messages, 'spawn_agent') ? { text: 'Waiting.' } : { tool: 'spawn_agent', arguments: { task_name: 'slow', message: 'Slow child job' } });
  agents.scripts.set('Slow child job', messages => called(messages, 'bash') ? { text: 'Child done.' } : { tool: 'bash', arguments: { command: 'sleep 3; echo done > child-late.txt' } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Delegate a slow job' });
  const childCalls = () => agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Slow child job') && text(request.messages.at(-1)).startsWith('Untrusted agent content'));
  for (let tries = 0; !childCalls().length && tries < 200; tries++) await Bun.sleep(100);
  await Bun.sleep(800);
  const { sessionFile } = await root.command({ type: 'get_state' });
  await agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath: sessionFile, terminalIds: [], clientId: 'laptop' });
  const calls = agents.model.requests.length;
  await Bun.sleep(4500);
  expect(existsSync(join(root.cwd, 'child-late.txt'))).toBe(false);
  expect(agents.model.requests.length).toBe(calls);
}, 60000);

test('stopping a parent that waits for its child stops both at once, and the parent makes no more model calls', async () => {
  agents.scripts.set('Wait for a slow child', messages => called(messages, 'wait_agent') ? { text: 'Kept going after stop.' }
    : called(messages, 'spawn_agent') ? { tool: 'wait_agent', arguments: { targets: ['patient'] } } : { tool: 'spawn_agent', arguments: { task_name: 'patient', message: 'Patient child job' } });
  agents.scripts.set('Patient child job', messages => called(messages, 'bash') ? { text: 'Child done.' } : { tool: 'bash', arguments: { command: 'sleep 3; echo done > patient-late.txt' } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Wait for a slow child' });
  const parentWaits = () => agents.model.requests.some(request => text(request.messages[1]) === 'Wait for a slow child' && called(request.messages, 'spawn_agent'));
  const childCalls = () => agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Patient child job') && text(request.messages.at(-1)).startsWith('Untrusted agent content'));
  for (let tries = 0; !(parentWaits() && childCalls().length) && tries < 200; tries++) await Bun.sleep(100);
  await Bun.sleep(800);
  const calls = agents.model.requests.length;
  await root.command({ type: 'abort' });
  await Bun.sleep(4500);
  expect(existsSync(join(root.cwd, 'patient-late.txt'))).toBe(false);
  expect(agents.model.requests.length).toBe(calls);
  expect((await root.history()).some(message => text(message) === 'Kept going after stop.')).toBe(false);
}, 60000);

test('pausing a parent cancels its busy child, and after resume the parent hears of it and the child takes the task again', async () => {
  agents.scripts.set('Pause while a child works', messages => {
    const last = text(messages.at(-1));
    const relay = last.match(/Relay: \w+/);
    if (relay) return { text: relay[0] };
    if (/patience: cancelled/.test(last) && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'patience', message: 'Try the slow job again' } };
    if (called(messages, 'spawn_agent') && !called(messages, 'wait_agent')) return { tool: 'wait_agent', arguments: { targets: ['patience'] } };
    return called(messages, 'spawn_agent') ? { text: 'Waiting.' } : { tool: 'spawn_agent', arguments: { task_name: 'patience', message: 'Paused child job' } };
  });
  agents.scripts.set('Paused child job', messages => JSON.stringify(messages).includes('Try the slow job again') ? { text: 'Relay: retried' }
    : called(messages, 'bash') ? { text: 'Relay: first' } : { tool: 'bash', arguments: { command: 'sleep 3' } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Pause while a child works' });
  const childStarted = () => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Paused child job') && text(request.messages.at(-1)).startsWith('Untrusted agent content'));
  for (let tries = 0; !childStarted() && tries < 200; tries++) await Bun.sleep(100);
  await Bun.sleep(800);
  await root.command({ type: 'pause' });
  await root.until(history => history.at(-1)?.stopReason === 'aborted');
  await root.command({ type: 'resume' });
  const messages = await root.until(history => text(history.at(-1)) === 'Relay: retried');
  expect(messages.some(message => text(message) === 'Relay: first')).toBe(false);
  expect(messages.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'followup_task'))).toBe(true);
}, 90000);

test('deleting a parent while its child runs a command stops the child and deletes both chats', async () => {
  agents.scripts.set('Delegate a doomed job', messages => called(messages, 'spawn_agent') ? { text: 'Waiting.' } : { tool: 'spawn_agent', arguments: { task_name: 'doomed', message: 'Doomed child job' } });
  agents.scripts.set('Doomed child job', messages => called(messages, 'bash') ? { text: 'Child done.' } : { tool: 'bash', arguments: { command: 'sleep 3; echo done > doomed-late.txt' } });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Delegate a doomed job' });
  const childCalls = () => agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Doomed child job') && text(request.messages.at(-1)).startsWith('Untrusted agent content'));
  for (let tries = 0; !childCalls().length && tries < 200; tries++) await Bun.sleep(100);
  await Bun.sleep(800);
  const { sessionFile } = await root.command({ type: 'get_state' });
  const deleted = await agents.daemon.invoke('delete_session', { hostId: 'local', sessionPath: sessionFile, clientId: 'laptop' });
  expect(deleted).toHaveLength(2);
  const calls = agents.model.requests.length;
  await Bun.sleep(4500);
  expect(existsSync(join(root.cwd, 'doomed-late.txt'))).toBe(false);
  expect(agents.model.requests.length).toBe(calls);
  const listed = (await agents.daemon.invoke('list_sessions')).map((session: any) => session.path);
  expect(deleted.some((path: string) => listed.includes(path))).toBe(false);
}, 60000);
