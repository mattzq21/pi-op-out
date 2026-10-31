import { randomUUID } from 'node:crypto';
import { text } from '../json';
import type { Mutex } from '../../util/sync';
import type { QueueDelivery } from '../queue_delivery';
import { materializeGoal } from './files';
import { goalChangedPrompt, goalSetPrompt } from './prompts';
import { GOAL_TOOL, type ContextInsertion, type Goal } from './state';

const USAGE = '/goal <objective | edit | pause | resume | clear>';
const ACTIONS = ['edit', 'pause', 'resume', 'clear'];

/** The /goal command as the composer lists it. Piop runs it, not Pi. */
export const GOAL_COMMAND = {
  name: 'goal',
  description: 'Persistent conversation goal. ' + USAGE,
  options: [{ value: '', label: '<objective | edit | pause | resume | clear>' }, ...ACTIONS.map(value => ({ value, label: value }))],
};

/** The tools that the queue answers, as Pi registers them. update_goal_status enters the prompt with a goal. */
export const QUEUE_TOOLS = [{
  name: GOAL_TOOL, label: 'Update goal', exposure: 'model-only',
  description: 'Set status to `paused` only when you can\'t progress. Report the returned status and stop goal work. Set status to `complete` only when the objective has actually been achieved and no required work remains.',
  parameters: { type: 'object', properties: { status: { type: 'string', enum: ['complete', 'paused'] } }, required: ['status'], additionalProperties: false },
}];

/** The argument of a /goal message, trimmed, or undefined for other messages. */
export function goalArgument(message: string): string | undefined {
  return /^\/goal(?:\s+([\s\S]*))?$/.exec(message.trimStart())?.[1]?.trim() ?? (/^\/goal\s*$/.test(message.trimStart()) ? '' : undefined);
}

/** True for a message that sets a new goal objective. It waits in the queue like any other message. */
export function goalSubmission(command: any): boolean {
  const value = goalArgument(text(command, 'message'));
  return value !== undefined && value !== '' && !ACTIONS.includes(value);
}

/**
 * Runs a /goal message. An objective is prepared, then waits in the queue; it becomes the goal when Pi takes it. The actions change the goal at once.
 * enqueue adds the prepared item to the queue while it holds the queue's lock.
 */
export async function goalCommand(queue: QueueDelivery, gate: Mutex, command: any, assertOwner: () => void, enqueue: (item: any) => Promise<any>): Promise<any> {
  const value = goalArgument(text(command, 'message')) ?? '';
  if (!value) throw new Error('Write an objective or an action after /goal. Usage: ' + USAGE);
  const goals = queue.state.goals;
  const locked = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const release = await gate.lock();
    try { assertOwner(); return await operation(); } finally { release(); }
  };
  switch (value) {
    case 'pause': await locked(() => change(queue, { ...goals.require(), status: 'paused' })); return handled;
    case 'resume': await locked(() => change(queue, { ...goals.require(), status: 'active' })); return handled;
    case 'clear': await locked(() => change(queue, null, goalChangedPrompt(null))); return handled;
    case 'edit': await edit(queue, locked); return handled;
  }
  const prepared = await prepareGoal(queue, value, text(command, 'goalSubmissionId') || undefined);
  if (!prepared) return false;
  return locked(() => enqueue({ ...command, ...prepared }));
}

/**
 * Prepares a new objective for the queue: the message that sets it and the goal it becomes. Undefined when the user keeps the current goal.
 * The objective's files are saved under submissionId, so a repeated submission gets the same files.
 */
export async function prepareGoal(queue: QueueDelivery, objective: string, submissionId?: string): Promise<{ message: string; preparedGoal: { id: string; objective: string } } | undefined> {
  const place = queue.goalPlace();
  if (queue.state.goals.live() && !(await queue.ask({ method: 'confirm', title: 'Replace current goal?', message: 'This replaces the current objective.' }))?.confirmed) return undefined;
  const draft = await materializeGoal(place, objective, submissionId);
  const preparedGoal = { id: randomUUID(), objective: draft.objective };
  try { await draft.bind(preparedGoal.id); } catch (error) { await draft.cleanup(); throw error; }
  return { message: '/goal ' + draft.objective, preparedGoal };
}

const handled = { disposition: 'handled' };

/** Lets the user edit the objective. The model gets a notice when the goal is active. */
async function edit(queue: QueueDelivery, locked: <T>(operation: () => T | Promise<T>) => Promise<T>): Promise<void> {
  const goals = queue.state.goals;
  const current = goals.require();
  const place = queue.goalPlace();
  const answer = await queue.ask({ method: 'editor', title: 'Edit goal', prefill: current.objective });
  if (typeof answer?.value !== 'string') return;
  const draft = await materializeGoal(place, answer.value, randomUUID());
  try {
    await locked(async () => {
      if (goals.goal?.id !== current.id) throw new Error('The goal changed while preparing this operation. Submit /goal again.');
      await draft.bind(current.id);
      const next: Goal = { ...goals.require(), objective: draft.objective };
      if (next.status === 'complete') next.status = 'active';
      return change(queue, next, goalChangedPrompt(next));
    });
  } catch (error) { await draft.cleanup(); throw error; }
}

/** Saves next as the goal, tells the agent with a notice when there is one, and shows the change. */
async function change(queue: QueueDelivery, next: Goal | null, notice: string | null = null): Promise<void> {
  const goals = queue.state.goals;
  // The user acted, so a chat that waited for the user's first message no longer waits.
  goals.waitingForInput = false;
  goals.save(queue.goalPlace(), next);
  try { if (notice !== null) await queue.execute({ type: 'insert_context', message: goals.notice(notice) }); }
  finally { await goalChanged(queue); }
}

/** Shows the goal to clients, and lets the follow-ups below a goal that ended go on. */
export async function goalChanged(queue: QueueDelivery): Promise<void> {
  const state = queue.state;
  queue.goalStatus(state.goals.status());
  if (!state.goals.live()) for (const item of state.pending) delete item.afterGoal;
  await queue.publish();
}

/** Makes the objective of a /goal item that Pi takes the goal. Returns the notice that goes before the item's message. */
export function activateGoal(queue: QueueDelivery, prepared: { id: string; objective: string }): ContextInsertion | undefined {
  const goals = queue.state.goals;
  if (goals.goal?.id === prepared.id) return undefined;
  const place = queue.goalPlace();
  goals.waitingForInput = false;
  goals.save(place, goals.create(place, prepared.objective, prepared.id));
  queue.goalStatus(goals.status());
  return goals.notice(goalSetPrompt);
}

/** Pi reports how its run ended. A run that failed or stopped pauses the active goal. */
export async function runEnded(queue: QueueDelivery, outcome: unknown): Promise<any> {
  const goals = queue.state.goals;
  if ((outcome === 'error' || outcome === 'aborted') && goals.active()) {
    goals.save(queue.goalPlace(), { ...goals.require(), status: 'paused' });
    await goalChanged(queue);
  }
  return queue.currentOffer();
}

/** Runs a tool call that the queue answers. */
export async function queueTool(queue: QueueDelivery, tool: unknown, params: any): Promise<{ text: string; details: unknown }> {
  if (tool !== GOAL_TOOL) throw new Error('Unknown queue tool ' + String(tool));
  const status = params?.status;
  if (status !== 'complete' && status !== 'paused') throw new Error('status must be complete or paused');
  const goals = queue.state.goals;
  const place = queue.goalPlace();
  // The model cannot complete or pause an objective it has not seen. The error gives it the edited objective.
  const edit = goals.unseenEdit();
  if (edit) { goals.markSeen(); throw new Error(edit); }
  const next: Goal = { ...goals.require(), status };
  goals.save(place, next);
  queue.goalStatus(goals.status());
  const data = { goal: { objective: next.objective, status: next.status } };
  if (status === 'complete') goals.save(place, null);
  await goalChanged(queue);
  return { text: JSON.stringify(data), details: data };
}
