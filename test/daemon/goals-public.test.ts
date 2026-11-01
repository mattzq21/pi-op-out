import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

/** Sends a message the way the composer does: through the queue, with the draft's submission ID. */
const send = (chat: Awaited<ReturnType<typeof agents.rootChat>>, message: string) => chat.command({ type: 'follow_up', message, goalSubmissionId: crypto.randomUUID() });
const goalRoles: string[] = [];
const turnsSoFar = (messages: any[]) => messages.filter(message => message.role === 'assistant' && text(message) === 'Still writing.').length;
/** The goal that the chat shows last, from the goal bar status. */
const shownGoal = (runtimeId: string) => { const status = agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.method === 'setStatus' && event.payload.event.statusKey === 'piop-goal').at(-1)?.payload.event.statusText; return status ? JSON.parse(status) : null; };
/** Waits until the queue hold is held, and returns the hold. */
const untilHeld = async (chat: Awaited<ReturnType<typeof agents.rootChat>>, held: boolean) => { let state: any; for (let tries = 0; (state = await chat.command({ type: 'get_state' })).queueHeld !== held && tries < 50; tries++) await Bun.sleep(100); return state.queueHeld; };
const settled = (runtimeId: string) => agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.type === 'agent_settled', 60000);

describe('goals', () => {

test('a goal keeps the agent working turn after turn until the agent marks it complete', async () => {
  agents.scripts.set('Write the report', messages => {
    goalRoles.push(...messages.filter((message: any) => text(message) === 'Write the report').map((message: any) => message.role));
    if (called(messages, 'update_goal_status')) return { text: 'Report finished.' };
    return turnsSoFar(messages) < 2 ? { text: 'Still writing.' } : { tool: 'update_goal_status', arguments: { status: 'complete' } };
  });
  const chat = await agents.rootChat();
  expect(await send(chat, '/goal Write the report')).not.toBe(false);
  const messages = await chat.until(history => text(history.at(-1)) === 'Report finished.');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Still writing.', 'Still writing.', 'Report finished.']);
  expect(goalRoles.length).toBeGreaterThan(0);
  expect(new Set(goalRoles)).toEqual(new Set(['user']));
  // The goal bar in the app reads these fields from the published goal status.
  const published = agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.method === 'setStatus' && event.payload.event.statusKey === 'piop-goal' && event.payload.event.statusText)
    .map(event => JSON.parse(event.payload.event.statusText));
  expect(published.at(0)).toMatchObject({ objective: 'Write the report', status: 'active' });
  expect(published.at(-1)).toMatchObject({ objective: 'Write the report', status: 'complete' });
  await settled(chat.runtimeId);
  expect(text((await chat.history()).at(-1))).toBe('Report finished.');
}, 120000);

test('Stop during a goal ends its turns at once and holds the queue, and resuming the queue starts them again', async () => {
  let calls = 0;
  agents.scripts.set('Never-ending goal', async () => { calls++; await Bun.sleep(300); return { text: 'Working.' }; });
  const chat = await agents.rootChat();
  const working = (history: any[]) => history.filter(message => text(message) === 'Working.').length;
  await send(chat, '/goal Never-ending goal');
  await chat.until(history => working(history) >= 2);
  await chat.command({ type: 'abort' });
  const stoppedAt = calls;
  await settled(chat.runtimeId);
  expect(calls).toBe(stoppedAt);
  expect(await untilHeld(chat, true)).toBe(true);
  expect(shownGoal(chat.runtimeId)).toMatchObject({ status: 'active', objective: 'Never-ending goal' });
  const done = working(await chat.history());
  await chat.command({ type: 'hold_queue', held: false });
  await chat.until(history => working(history) >= done + 2);
  await chat.command({ type: 'abort' });
}, 120000);

test('a goal continues through empty replies and large usage until completed', async () => {
  let calls = 0;
  agents.scripts.set('Keep going without limits', messages => {
    if (called(messages, 'update_goal_status')) return { text: 'Finished without limits.' };
    calls++;
    return calls <= 7 ? { text: '', tokens: 100000 } : { tool: 'update_goal_status', arguments: { status: 'complete' } };
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

test('a goal whose model keeps refusing for a rate limit is retried, then the queue is held', async () => {
  let calls = 0;
  agents.scripts.set('Beat the rate limit', () => { calls++; throw new Error('Rate limit exceeded'); });
  const chat = await agents.rootChat();
  const entries = async () => (await chat.command({ type: 'get_entries' })).entries;
  await send(chat, '/goal Beat the rate limit');
  await settled(chat.runtimeId);
  expect(calls).toBe(4);
  expect(await untilHeld(chat, true)).toBe(true);
  expect(shownGoal(chat.runtimeId)).toMatchObject({ status: 'active', objective: 'Beat the rate limit' });
  expect(calls).toBe(4);
}, 120000);

test('a goal continues after repeated tool failures', async () => {
  agents.scripts.set('Read the missing file', messages => {
    if (called(messages, 'update_goal_status')) return { text: 'Failure handled.' };
    if (messages.filter((message: any) => text(message) === 'Could not read it.').length >= 7) return { tool: 'update_goal_status', arguments: { status: 'complete' } };
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
  const objective = 'Translate the long brief. ' + 'Every line matters. '.repeat(300);
  let file = '';
  agents.scripts.set('Read the goal objective file at', messages => {
    file ||= JSON.stringify(messages).match(/Read the goal objective file at ([^ ]+?\.md)/)?.[1] ?? '';
    return called(messages, 'update_goal_status') ? { text: 'Brief done.' } : { tool: 'update_goal_status', arguments: { status: 'complete' } };
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

test('a goal is a queue entry: follow-ups below it wait, a follow-up moved above it runs first, and moving it back keeps it waiting', async () => {
  const requests: boolean[] = [];
  let gate: (() => void) | undefined;
  let blocking = true;
  let finish = false;
  agents.scripts.set('Keep drafting', async messages => {
    const said = (value: string) => messages.some((message: any) => message.role === 'user' && text(message).includes(value));
    requests.push(said('Question one'));
    // A reply takes a moment, as a real model's does. Instant replies make the goal run turns so fast that no history read finds the chat unchanged.
    if (blocking) await new Promise<void>(resolve => { gate = resolve; }); else await Bun.sleep(100);
    if (said('Question one') && !messages.some((message: any) => message.role === 'assistant' && text(message) === 'Answered one.')) return { text: 'Answered one.' };
    if (called(messages, 'update_goal_status')) return { text: 'Drafted.' };
    return finish ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : { text: 'Drafting.' };
  });
  const untilRequest = async (count: number) => { for (let tries = 0; !(requests.length >= count && gate) && tries < 300; tries++) await Bun.sleep(50); expect(requests.length).toBeGreaterThanOrEqual(count); };
  const release = () => { const resolve = gate; gate = undefined; resolve?.(); };
  const chat = await agents.rootChat();
  const queue = async () => ((await chat.command({ type: 'get_state' })).pendingMessages ?? []).map((entry: any) => entry.goal ? 'goal' : entry.message);
  const id = async (message: string) => ((await chat.command({ type: 'get_state' })).pendingMessages ?? []).find((entry: any) => entry.message === message && !entry.goal).id;
  await send(chat, '/goal Keep drafting');
  await untilRequest(1);
  expect(await queue()).toEqual(['goal']);
  await send(chat, 'Question one');
  expect(await queue()).toEqual(['goal', 'Question one']);
  await chat.command({ type: 'change_pending', id: await id('Question one'), action: 'moveUp' });
  expect(await queue()).toEqual(['Question one', 'goal']);
  await chat.command({ type: 'change_pending', id: await id('Question one'), action: 'moveDown' });
  expect(await queue()).toEqual(['goal', 'Question one']);
  release();
  await untilRequest(2);
  expect(requests[1]).toBe(false);
  await chat.command({ type: 'change_pending', id: 'goal', action: 'moveDown' });
  await Bun.sleep(300);
  expect(await queue()).toEqual(['Question one', 'goal']);
  blocking = false;
  release();
  await chat.until(history => history.some(message => text(message) === 'Answered one.'));
  await chat.until(history => history.filter(message => text(message) === 'Drafting.').length >= 3);
  finish = true;
  const history = await chat.until(history => text(history.at(-1)) === 'Drafted.');
  const replies = history.filter(message => message.role === 'assistant').map(text).filter(Boolean);
  expect(replies.slice(0, 3)).toEqual(['Drafting.', 'Drafting.', 'Answered one.']);
  expect(await queue()).toEqual([]);
}, 120000);

test('a follow-up below the goal entry goes to the agent when the goal is complete, and goal commands do not wait', async () => {
  let finish = false;
  agents.scripts.set('Finish the plan', async messages => {
    await Bun.sleep(100);
    if (messages.some((message: any) => message.role === 'user' && text(message).includes('Question two'))) return { text: 'Answered two.' };
    if (called(messages, 'update_goal_status')) return { text: 'Planned.' };
    return finish ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : { text: 'Planning.' };
  });
  const chat = await agents.rootChat();
  await send(chat, '/goal Finish the plan');
  await chat.until(history => history.some(message => text(message) === 'Planning.'));
  await send(chat, 'Question two');
  expect(((await chat.command({ type: 'get_state' })).pendingMessages ?? []).map((entry: any) => entry.goal ? 'goal' : entry.message)).toEqual(['goal', 'Question two']);
  await chat.until(history => history.filter(message => text(message) === 'Planning.').length >= 3);
  expect((await chat.history()).some(message => text(message) === 'Answered two.')).toBe(false);
  finish = true;
  const history = await chat.until(history => text(history.at(-1)) === 'Answered two.');
  const replies = history.filter(message => message.role === 'assistant').map(text).filter(Boolean);
  expect(replies.indexOf('Planned.')).toBeLessThan(replies.indexOf('Answered two.'));
  expect(((await chat.command({ type: 'get_state' })).pendingMessages ?? [])).toEqual([]);
}, 120000);
test('a held queue holds the goal: no goal turn runs until the user resumes, and a message above the goal goes first', async () => {
  let requests = 0;
  let gate: (() => void) | undefined;
  let finish = false;
  agents.scripts.set('Keep polishing', async messages => {
    requests += 1;
    if (requests === 1) await new Promise<void>(resolve => { gate = resolve; }); else await Bun.sleep(100);
    const last = messages.findLast((message: any) => message.role === 'user');
    if (text(last) === 'Question three') return { text: 'Answered three.' };
    if (called(messages, 'update_goal_status')) return { text: 'Polished.' };
    return finish ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : { text: 'Polishing.' };
  });
  const chat = await agents.rootChat();
  const queue = async () => ((await chat.command({ type: 'get_state' })).pendingMessages ?? []).map((entry: any) => entry.goal ? 'goal' : entry.message);
  const quiet = async () => { const seen = requests; await Bun.sleep(1000); expect(requests).toBe(seen); };
  await send(chat, '/goal Keep polishing');
  for (let tries = 0; !gate && tries < 100; tries++) await Bun.sleep(50);
  await chat.command({ type: 'hold_queue', held: true });
  await send(chat, 'Question three');
  const id = ((await chat.command({ type: 'get_state' })).pendingMessages ?? []).find((entry: any) => entry.message === 'Question three').id;
  await chat.command({ type: 'change_pending', id, action: 'moveUp' });
  expect(await queue()).toEqual(['Question three', 'goal']);
  const firstSettled = settled(chat.runtimeId);
  gate!();
  await firstSettled;
  await quiet();
  expect(requests).toBe(1);
  expect(shownGoal(chat.runtimeId)?.status).toBe('active');

  await chat.command({ type: 'hold_queue', held: false });
  await chat.until(history => history.filter(message => text(message) === 'Polishing.').length >= 2);
  const replies = (await chat.history()).filter(message => message.role === 'assistant').map(text).filter(Boolean);
  expect(replies.slice(0, 3)).toEqual(['Polishing.', 'Answered three.', 'Polishing.']);

  await chat.command({ type: 'hold_queue', held: true });
  for (let tries = 0; (await chat.command({ type: 'get_state' })).isStreaming && tries < 100; tries++) await Bun.sleep(100);
  await quiet();
  const before = requests;
  await chat.command({ type: 'hold_queue', held: false });
  for (let tries = 0; requests === before && tries < 100; tries++) await Bun.sleep(50);
  expect(requests).toBeGreaterThan(before);
  finish = true;
  await chat.until(history => text(history.at(-1)) === 'Polished.');
}, 120000);
test('a new goal sent while the queue is on hold waits in the queue and starts only when the user resumes', async () => {
  let requests = 0;
  agents.scripts.set('Tidy the docs', async messages => {
    requests += 1;
    await Bun.sleep(100);
    if (called(messages, 'update_goal_status')) return { text: 'Tidied.' };
    return { tool: 'update_goal_status', arguments: { status: 'complete' } };
  });
  const chat = await agents.rootChat();
  await chat.command({ type: 'hold_queue', held: true });
  await chat.command({ type: 'prompt', message: '/goal Tidy the docs', goalSubmissionId: crypto.randomUUID() });
  await Bun.sleep(1000);
  expect(requests).toBe(0);
  expect(shownGoal(chat.runtimeId)).toBeNull();
  expect(((await chat.command({ type: 'get_state' })).pendingMessages ?? []).map((entry: any) => entry.message)).toEqual(['/goal Tidy the docs']);
  await chat.command({ type: 'hold_queue', held: false });
  await chat.until(history => text(history.at(-1)) === 'Tidied.');
  expect(requests).toBeGreaterThan(0);
}, 60000);
test('an edited goal objective in a held queue is prepared again, and the goal starts with the new objective', async () => {
  agents.scripts.set('Draft the new plan', async messages => { await Bun.sleep(100); return called(messages, 'update_goal_status') ? { text: 'Planned.' } : { tool: 'update_goal_status', arguments: { status: 'complete' } }; });
  agents.scripts.set('Draft the old plan', () => ({ text: 'Wrong objective.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'hold_queue', held: true });
  await send(chat, '/goal Draft the old plan');
  const queued = ((await chat.command({ type: 'get_state' })).pendingMessages ?? [])[0];
  expect(queued.message).toBe('/goal Draft the old plan');
  await chat.command({ type: 'change_pending', id: queued.id, action: { type: 'edit', message: '/goal Draft the new plan', images: { keep: [], add: [] } } });
  expect(((await chat.command({ type: 'get_state' })).pendingMessages ?? []).map((entry: any) => entry.message)).toEqual(['/goal Draft the new plan']);
  await chat.command({ type: 'hold_queue', held: false });
  await chat.until(history => text(history.at(-1)) === 'Planned.');
  const said = agents.model.requests.flatMap(request => request.messages.filter((message: any) => message.role === 'user').map(text));
  expect(said.some((content: string) => content.includes('Draft the new plan'))).toBe(true);
  expect(said.some((content: string) => content.includes('Draft the old plan'))).toBe(false);
}, 60000);

});
