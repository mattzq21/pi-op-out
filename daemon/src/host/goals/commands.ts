import { randomUUID } from 'node:crypto';
import { text } from '../json';
import type { QueueDelivery, QueueGate } from '../queue';
import { agentObjective, validateObjective } from './files';
import { goalChangedPrompt, goalSetPrompt } from './prompts';
import { GOAL_TOOL, type ContextInsertion, type Goal } from './state';

const USAGE = '/goal <objective | edit | clear>';
const ACTIONS = ['edit', 'clear'];

export const GOAL_COMMAND = {
  name: 'goal',
  description: 'Persistent conversation goal. ' + USAGE,
  options: [{ value: '', label: '<objective | edit | clear>' }, ...ACTIONS.map(value => ({ value, label: value }))],
};

export const QUEUE_TOOLS = [{
  name: GOAL_TOOL, label: 'Update goal', exposure: 'model-only',
  description: 'Set status to `paused` only when you can\'t progress: it holds the queue until the user resumes it. Report the returned status and stop goal work. Set status to `complete` only when the objective has actually been achieved and no required work remains.',
  parameters: { type: 'object', properties: { status: { type: 'string', enum: ['complete', 'paused'] } }, required: ['status'], additionalProperties: false },
}];

export function goalArgument(message: string): string | undefined {
  return /^\/goal(?:\s+([\s\S]*))?$/.exec(message.trimStart())?.[1]?.trim() ?? (/^\/goal\s*$/.test(message.trimStart()) ? '' : undefined);
}

export function goalSubmission(command: any): boolean {
  const value = goalArgument(text(command, 'message'));
  return value !== undefined && value !== '' && !ACTIONS.includes(value);
}

export async function goalCommand(queue: QueueDelivery, gate: QueueGate, command: any, assertOwner: () => void, enqueue: (item: any) => Promise<any>): Promise<any> {
  const value = goalArgument(text(command, 'message')) ?? '';
  if (!value) throw new Error('Write an objective or an action after /goal. Usage: ' + USAGE);
  const goals = queue.state.goals;
  const locked = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const release = await gate.lock();
    try { assertOwner(); return await operation(); } finally { release(); }
  };
  switch (value) {
    case 'clear': await locked(() => change(queue, null, goalChangedPrompt(null))); return handled;
    case 'edit': await edit(queue, locked); return handled;
  }
  const prepared = await prepareGoal(queue, value, text(command, 'goalSubmissionId') || undefined);
  if (!prepared) return false;
  return locked(() => enqueue({ ...command, ...prepared }));
}

export async function prepareGoal(queue: QueueDelivery, objective: string, submissionId?: string): Promise<{ message: string; preparedGoal: { id: string; objective: string; submissionId?: string } } | undefined> {
  const place = queue.goalPlace();
  const value = validateObjective(objective);
  if (queue.state.goals.live() && !(await queue.ask({ method: 'confirm', title: 'Replace current goal?', message: 'This replaces the current objective.' }))?.confirmed) return undefined;
  const preparedGoal = { id: randomUUID(), objective: value, ...submissionId ? { submissionId } : {} };
  return { message: '/goal ' + agentObjective(place, value), preparedGoal };
}

const handled = { disposition: 'handled' };

async function edit(queue: QueueDelivery, locked: <T>(operation: () => T | Promise<T>) => Promise<T>): Promise<void> {
  const goals = queue.state.goals;
  const current = goals.require();
  const place = queue.goalPlace();
  const answer = await queue.ask({ method: 'editor', title: 'Edit goal', prefill: current.objective });
  if (typeof answer?.value !== 'string') return;
  const objective = validateObjective(answer.value);
  await locked(async () => {
    if (goals.goal?.id !== current.id) throw new Error('The goal changed while preparing this operation. Submit /goal again.');
    const next: Goal = { ...goals.require(), objective, status: 'active' };
    goals.waitingForInput = false;
    goals.save(place, next);
    return announce(queue, goalChangedPrompt(goals.shown(place, next)));
  });
}

async function change(queue: QueueDelivery, next: Goal | null, notice: string | null = null): Promise<void> {
  const goals = queue.state.goals;
  goals.waitingForInput = false;
  goals.save(queue.goalPlace(), next);
  await announce(queue, notice);
}

async function announce(queue: QueueDelivery, notice: string | null): Promise<void> {
  const goals = queue.state.goals;
  try { if (notice !== null) await queue.execute({ type: 'insert_context', message: goals.notice(notice) }); }
  finally { await goalChanged(queue); }
}

export async function goalChanged(queue: QueueDelivery): Promise<void> {
  const state = queue.state;
  queue.goalStatus(state.goals.status());
  if (!state.goals.live()) for (const item of state.pending) delete item.afterGoal;
  await queue.publish();
}

export function activateGoal(queue: QueueDelivery, prepared: { id: string; objective: string; submissionId?: string }): ContextInsertion | undefined {
  const goals = queue.state.goals;
  if (goals.goal?.id === prepared.id) return undefined;
  const place = queue.goalPlace();
  goals.waitingForInput = false;
  goals.save(place, goals.create(place, prepared.objective, prepared.id, prepared.submissionId));
  queue.goalStatus(goals.status());
  return goals.notice(goalSetPrompt);
}

export async function runEnded(queue: QueueDelivery, outcome: unknown): Promise<any> {
  if (outcome === 'error' && queue.state.goals.live()) await queue.reportStorageError(() => queue.hold(true));
  return queue.currentOffer();
}

export async function queueTool(queue: QueueDelivery, tool: unknown, params: any): Promise<{ text: string; details: unknown }> {
  if (tool !== GOAL_TOOL) throw new Error('Unknown queue tool ' + String(tool));
  const status = params?.status;
  if (status !== 'complete' && status !== 'paused') throw new Error('status must be complete or paused');
  const goals = queue.state.goals;
  const place = queue.goalPlace();
  const edit = goals.unseenEdit(place);
  if (edit) { goals.markSeen(); throw new Error(edit); }
  const goal = goals.require();
  const data = { goal: { objective: goals.shown(place, goal).objective, status } };
  if (status === 'paused') await queue.hold(true);
  else {
    goals.save(place, { ...goal, status });
    queue.goalStatus(goals.status());
    goals.save(place, null);
    await goalChanged(queue);
  }
  return { text: JSON.stringify(data), details: data };
}
