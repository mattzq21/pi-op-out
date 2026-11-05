import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionQueue } from '../../daemon/src/host/queue';
import { QueueGoal } from '../../daemon/src/host/goals/state';
import * as database from '../../daemon/resources/session-database.ts';
import * as goals from '../../daemon/resources/piop-storage/goals.ts';

const root = mkdtempSync(join(tmpdir(), 'piop-queue-goal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'sessions'));
let chats = 0;

function chat(status: 'active' | null, pending: any[] = [], extra: { held?: boolean; waiting?: boolean } = {}) {
  const sessionId = 'chat-' + ++chats;
  const file = join(root, 'sessions', sessionId + '.jsonl');
  writeFileSync(file, '');
  const db = database.connection(root);
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(sessionId, file);
  if (extra.waiting) db.prepare("INSERT INTO session_extension_state VALUES (?, 'piop-input-hold', ?)").run(sessionId, JSON.stringify({ type: 'custom', customType: 'piop-input-hold', data: { held: true } }));
  if (status) goals.write(file, sessionId, { id: 'goal-' + sessionId, sessionId, objective: 'Build', status });
  const commands: any[] = [];
  const statuses: any[] = [];
  const queue = new SessionQueue({
    execute: async command => { commands.push(command); return null; }, publish: () => {}, queueHeld: async () => {},
    goalPlace: () => ({ file, sessionId, cwd: root }), goalStatus: event => statuses.push(event), ask: async () => ({ value: 'Build more' }),
  }, pending, null, extra.held ?? false, QueueGoal.restore(file));
  const take = async (behavior: string) => (await queue.runtimeEvent('queue_take', { behavior })).item;
  const shown = () => { const text = statuses.at(-1)?.statusText; return text ? JSON.parse(text) : null; };
  return { queue, commands, take, shown, saved: () => goals.read(file, sessionId) };
}

test('an opened chat shows its saved goal before Pi starts', () => {
  const { queue } = chat('active');
  expect(JSON.parse(queue.goalStatus().statusText)).toMatchObject({ objective: 'Build', status: 'active' });
  expect(queue.view().pendingMessages).toEqual([{ id: 'goal', message: 'Build', behavior: 'followUp', goal: true }]);
});

test('the goal keeps follow-ups below it waiting, and a follow-up moved above it is taken first', async () => {
  const { queue, take } = chat('active');
  await queue.command({ type: 'follow_up', message: 'Next message' });
  expect(await take('followUp')).toBeNull();
  const id = queue.view().pendingMessages.find((item: any) => item.message === 'Next message').id;
  await queue.changePending(id, { type: 'move', targetId: 'goal', edge: 'before' });
  expect(await take('goal')).toBeNull();
  expect((await take('followUp'))?.message).toBe('Next message');
});

test('the goal gives its prompt only while active, not held, and with no message waiting before it', async () => {
  const { queue, take } = chat('active');
  expect((await take('goal'))?.insertion).toMatchObject({ customType: 'piop-goal-context', content: 'Build', display: true });
  await queue.command({ type: 'hold_queue', held: true });
  expect(await take('goal')).toBeNull();
  await queue.command({ type: 'hold_queue', held: false });
  await queue.command({ type: 'steer', message: 'Steer now' });
  expect(await take('goal')).toBeNull();
  expect((await take('steer'))?.message).toBe('Steer now');
  expect(await take('goal')).not.toBeNull();
});

test('a chat that waits for the user\'s first message keeps its active goal, and the goal goes on once a run starts', async () => {
  const { queue, take } = chat('active', [], { waiting: true });
  await queue.command({ type: 'follow_up', message: 'Branch prompt' });
  expect(await take('goal')).toBeNull();
  expect((await take('followUp'))?.message).toBe('Branch prompt');
  await queue.receive({ type: 'agent_start' });
  expect(await take('goal')).not.toBeNull();
});

test('clear changes the saved goal at once, and the follow-ups below a cleared goal go on', async () => {
  const { queue, take, shown, saved, commands } = chat('active');
  await queue.command({ type: 'follow_up', message: 'Next message' });
  expect(await take('followUp')).toBeNull();
  expect(await queue.command({ type: 'prompt', message: '/goal clear' })).toEqual({ disposition: 'handled' });
  expect(saved()).toBeNull();
  expect(shown()).toBeNull();
  expect(commands.filter(command => command.type === 'insert_context').map(command => command.message.content)).toEqual(['The goal has been cleared. Follow next instructions, the goal is in the past now.']);
  expect((await take('followUp'))?.message).toBe('Next message');
});

test('a run that fails while a goal is set holds the queue, and the goal goes on when the user resumes', async () => {
  const { queue, saved } = chat('active');
  expect((await queue.runtimeEvent('queue_outcome', { outcome: 'completed' })).goal).toBe(1);
  expect((await queue.runtimeEvent('queue_outcome', { outcome: 'error' })).goal).toBe(0);
  expect(queue.view().held).toBe(true);
  expect(saved()?.status).toBe('active');
  await queue.command({ type: 'hold_queue', held: false });
  expect((await queue.runtimeEvent('queue_outcome', { outcome: 'completed' })).goal).toBe(1);
});

test('the goal tool with paused holds the queue and keeps the goal', async () => {
  const { queue, take, saved } = chat('active');
  await take('goal');
  expect(await queue.runtimeEvent('queue_tool', { tool: 'update_goal_status', params: { status: 'paused' } })).toMatchObject({ details: { goal: { objective: 'Build', status: 'paused' } } });
  expect(queue.view().held).toBe(true);
  expect(saved()?.status).toBe('active');
  expect(await take('goal')).toBeNull();
});

test('a stop holds the queue while a goal is set, and the next message goes first', async () => {
  const { queue } = chat('active');
  await queue.command({ type: 'follow_up', message: 'Waiting' });
  await queue.command({ type: 'abort' });
  expect(queue.view().held).toBe(true);
  await queue.command({ type: 'steer', message: 'Correction' });
  expect(queue.view().pendingMessages.map((item: any) => item.message)).toEqual(['Correction', 'Build', 'Waiting']);
});

test('the goal tool completes the goal, and fails once for an edited objective the model has not seen', async () => {
  const { queue, take, saved } = chat('active');
  await take('goal');
  await queue.command({ type: 'prompt', message: '/goal edit' });
  expect(saved()?.objective).toBe('Build more');
  await expect(queue.runtimeEvent('queue_tool', { tool: 'update_goal_status', params: { status: 'complete' } })).rejects.toThrow('Current goal is:\nBuild more');
  expect(await queue.runtimeEvent('queue_tool', { tool: 'update_goal_status', params: { status: 'complete' } })).toMatchObject({ details: { goal: { objective: 'Build more', status: 'complete' } } });
  expect(saved()).toBeNull();
  expect((await queue.runtimeEvent('queue_outcome', { outcome: 'completed' })).tools).toEqual({ update_goal_status: false });
});

test('cancelling a delegation does not hold the queue, even with a goal and waiting messages', async () => {
  const { queue } = chat('active');
  await queue.command({ type: 'follow_up', message: 'Waiting' });
  await queue.interruptDelegation();
  expect(queue.view().held).toBe(false);
});

test('a stop holds the queue when the only message is one that Pi took, so it does not start again when Pi releases it', async () => {
  const { queue, take } = chat(null);
  await queue.command({ type: 'follow_up', message: 'Taken' });
  const id = (await take('followUp')).id;
  await queue.command({ type: 'abort' });
  expect(queue.view().held).toBe(true);
  await queue.runtimeEvent('queue_release', { ids: [id] });
  expect(await take('followUp')).toBeNull();
});

test('a stop does not hold the queue when the only message is one that Pi already used', async () => {
  const { queue, take } = chat(null);
  await queue.command({ type: 'follow_up', message: 'Used' });
  const id = (await take('followUp')).id;
  queue.observe({ type: 'message_start', message: { role: 'user', piopQueueId: id, timestamp: 1, content: 'Used' } });
  await queue.command({ type: 'abort' });
  expect(queue.view().held).toBe(false);
});

test('a cancelled delegation that Pi reports as aborted does not hold the queue while a goal is set', async () => {
  const { queue } = chat('active');
  await queue.interruptDelegation();
  expect((await queue.runtimeEvent('queue_outcome', { outcome: 'aborted' })).goal).toBe(1);
  expect(queue.view().held).toBe(false);
});
