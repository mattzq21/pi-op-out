import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

/** Sends a message the way the composer does: through the queue, with the draft's submission ID. */
const send = (chat: Awaited<ReturnType<typeof agents.rootChat>>, message: string) => chat.command({ type: 'follow_up', message, goalSubmissionId: crypto.randomUUID() });
const turnsSoFar = (messages: any[]) => messages.filter(message => message.role === 'assistant' && text(message) === 'Still writing.').length;
const notices = (runtimeId: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.method === 'notify').map(event => event.payload.event.message);

test('a goal needs the goal tools, and without them the user is told how to enable them', async () => {
  const chat = await agents.rootChat();
  expect(await send(chat, '/goal Write the report')).toBe(false);
  expect(notices(chat.runtimeId)).toContain('Enable get_goal, create_goal and update_goal for this agent under Settings → Agents → Tools before starting a goal.');
  expect(await chat.history()).toEqual([]);
}, 60000);

test('a goal keeps the agent working turn after turn until the agent marks it complete', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  agents.scripts.set('Write the report', messages => {
    if (called(messages, 'update_goal')) return { text: 'Report finished.' };
    return turnsSoFar(messages) < 2 ? { text: 'Still writing.' } : { tool: 'update_goal', arguments: { status: 'complete' } };
  });
  const chat = await agents.rootChat();
  await send(chat, '/goal Write the report');
  const messages = await chat.until(history => text(history.at(-1)) === 'Report finished.');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Still writing.', 'Still writing.', 'Report finished.']);
  // The goal bar in the app reads these fields from the published goal status.
  const published = agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.method === 'setStatus' && event.payload.event.statusKey === 'piop-goal' && event.payload.event.statusText)
    .map(event => JSON.parse(event.payload.event.statusText));
  expect(published.at(0)).toMatchObject({ objective: 'Write the report', status: 'active' });
  expect(published.at(-1)).toMatchObject({ objective: 'Write the report', status: 'complete' });
  await Bun.sleep(1500);
  expect(text((await chat.history()).at(-1))).toBe('Report finished.');
}, 120000);

test('pausing a goal stops the extra turns, and resuming starts them again', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  let finish = false;
  agents.scripts.set('Keep polishing', async messages => {
    await Bun.sleep(200);
    if (called(messages, 'update_goal')) return { text: 'Polished.' };
    return finish ? { tool: 'update_goal', arguments: { status: 'complete' } } : { text: 'Polishing.' };
  });
  const chat = await agents.rootChat();
  const turns = async () => (await chat.history()).filter(message => message.role === 'assistant' && text(message) === 'Polishing.').length;
  await send(chat, '/goal Keep polishing');
  await chat.until(history => history.filter(message => text(message) === 'Polishing.').length >= 2);
  expect(await send(chat, '/goal pause')).toEqual({ disposition: 'handled' });
  await Bun.sleep(1000);
  const paused = await turns();
  await Bun.sleep(1500);
  expect(await turns()).toBe(paused);
  finish = true;
  await send(chat, '/goal resume');
  await chat.until(history => text(history.at(-1)) === 'Polished.');
}, 120000);

test('Stop during a goal ends its turns at once and marks it paused, and resuming the goal starts them again', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  let calls = 0;
  agents.scripts.set('Never-ending goal', async () => { calls++; await Bun.sleep(300); return { text: 'Working.' }; });
  const chat = await agents.rootChat();
  const entries = async () => (await chat.command({ type: 'get_entries' })).entries;
  const summary = async () => {
    const before = (await entries()).filter((entry: any) => entry.customType === 'piop-goal-summary').length;
    await send(chat, '/goal');
    let latest: any[] = [];
    for (let tries = 0; latest.length <= before && tries < 50; tries++, await Bun.sleep(100)) latest = (await entries()).filter((entry: any) => entry.customType === 'piop-goal-summary');
    return text(latest.at(-1));
  };
  const working = (history: any[]) => history.filter(message => text(message) === 'Working.').length;
  await send(chat, '/goal Never-ending goal');
  await chat.until(history => working(history) >= 2);
  await chat.command({ type: 'abort' });
  const stoppedAt = calls;
  await Bun.sleep(2000);
  expect(calls).toBe(stoppedAt);
  expect(await summary()).toStartWith('Goal paused\n\nNever-ending goal');
  const done = working(await chat.history());
  await send(chat, '/goal resume');
  await chat.until(history => working(history) >= done + 2);
  await send(chat, '/goal pause');
  expect(await summary()).toStartWith('Goal paused');
}, 120000);


test('a goal continues through empty replies and large usage until completed', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  let calls = 0;
  agents.scripts.set('Keep going without limits', messages => {
    if (called(messages, 'update_goal')) return { text: 'Finished without limits.' };
    calls++;
    return calls <= 7 ? { text: '', tokens: 100000 } : { tool: 'update_goal', arguments: { status: 'complete' } };
  });
  const chat = await agents.rootChat();
  await send(chat, '/goal Keep going without limits');
  await chat.until(history => text(history.at(-1)) === 'Finished without limits.');
  expect(calls).toBe(8);
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  const goals = entries.filter((entry: any) => entry.customType === 'piop-goal');
  expect(goals).toEqual([]);
  const state = await chat.command({ type: 'get_state' });
  const saved = readFileSync(state.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(saved.filter((entry: any) => entry.customType === 'piop-goal')).toEqual(goals);
}, 120000);

test('a goal whose model keeps refusing for a rate limit is retried, then its goal and chat are paused', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  let calls = 0;
  agents.scripts.set('Beat the rate limit', () => { calls++; throw new Error('Rate limit exceeded'); });
  const chat = await agents.rootChat();
  const entries = async () => (await chat.command({ type: 'get_entries' })).entries;
  await send(chat, '/goal Beat the rate limit');
  for (let tries = 0; calls < 4 && tries < 300; tries++) await Bun.sleep(100);
  await Bun.sleep(3000);
  expect(calls).toBe(4);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(true);
  await send(chat, '/goal');
  let summary = '';
  for (let tries = 0; !summary && tries < 50; tries++, await Bun.sleep(100)) summary = (await entries()).filter((entry: any) => entry.customType === 'piop-goal-summary').map((entry: any) => text(entry)).at(-1) ?? '';
  expect(summary).toStartWith('Goal paused\n\nBeat the rate limit');
  expect(calls).toBe(4);
}, 120000);

test('a goal continues after repeated tool failures', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  agents.scripts.set('Read the missing file', async messages => {
    await Bun.sleep(100);
    if (called(messages, 'update_goal')) return { text: 'Failure handled.' };
    if (messages.filter((message: any) => text(message) === 'Could not read it.').length >= 7) return { tool: 'update_goal', arguments: { status: 'complete' } };
    const previous = messages.findLast((message: any) => message.role === 'assistant');
    return previous?.tool_calls?.length ? { text: 'Could not read it.' } : { tool: 'read', arguments: { path: '/nonexistent/piop-test-file' } };
  });
  const chat = await agents.rootChat();
  const failedReads = async () => (await chat.history()).filter(message => message.role === 'toolResult' && message.toolName === 'read' && message.isError).length;
  await send(chat, '/goal Read the missing file');
  await chat.until(history => text(history.at(-1)) === 'Failure handled.');
  expect(await failedReads()).toBeGreaterThanOrEqual(7);
}, 120000);

test('a long goal is saved to a file the agent reads, which stays while any chat still uses it', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  const objective = 'Translate the long brief. ' + 'Every line matters. '.repeat(300);
  let file = '';
  agents.scripts.set('Read the goal objective file at', messages => {
    file ||= JSON.stringify(messages).match(/Read the goal objective file at ([^ ]+?\.md)/)?.[1] ?? '';
    return called(messages, 'update_goal') ? { text: 'Brief done.' } : { tool: 'update_goal', arguments: { status: 'complete' } };
  });
  const chat = await agents.rootChat({ repository: true });
  await send(chat, '/goal ' + objective);
  await chat.until(history => text(history.at(-1)) === 'Brief done.');
  expect(readFileSync(file, 'utf8').trim()).toBe(objective.trim());

  const original = await chat.command({ type: 'get_state' });
  const answer = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === 'Brief done.');
  await chat.command({ type: 'fork_after', entryId: answer.id });
  const fork = await chat.command({ type: 'get_state' });
  const remove = (sessionPath: string) => agents.daemon.invoke('delete_session', { sessionPath, hostId: 'local', clientId: 'laptop' });
  await remove(original.sessionFile);
  // The fork's history still tells its agent to read this file.
  expect(JSON.stringify(await chat.command({ type: 'get_entries' }))).toContain(file);
  expect(readFileSync(file, 'utf8').trim()).toBe(objective.trim());
  await remove(fork.sessionFile);
  expect(existsSync(file)).toBe(false);
}, 120000);
