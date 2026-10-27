import { clone, text } from './json';
import { CommandRefusedError } from '../pi_rejection';
import { validateItem } from './queue_storage';
import { durableMessages } from './queue_state';
import type { QueueDelivery } from './queue_delivery';

export { queuedCommand } from '../plugin_contributions';

function goalObjective(message: string): boolean {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('/goal')) return false;
  const rest = trimmed.slice(5);
  if (!/^\s/u.test(rest)) return false;
  const value = rest.trim();
  return value.length > 0 && !['edit', 'clear', 'pause', 'resume', 'budget'].includes(value) && !value.startsWith('budget ');
}

function goalSubmission(command: any): boolean {
  const message = text(command, 'message');
  return goalObjective(message) || (message.trim() === '/goal' && Array.isArray(command.images) && command.images.length > 0);
}

function submissionPayload(command: any, id: string, name: string): any {
  const pending: any = { id, message: command.message ?? null, behavior: name === 'steer' ? 'steer' : 'followUp' };
  for (const field of ['images', 'goalSubmissionId', 'goalPrepared']) if (command[field] !== undefined) pending[field] = clone(command[field]);
  return pending;
}

/**
 * Adds a steer or follow-up message to the queue and sends it to Pi.
 * Returns null for an item kept for retry after a failure.
 * Returns false when goal preparation declines the message.
 */
export async function enqueue(queue: QueueDelivery, command: any, name: string): Promise<any> {
  const state = queue.state;
  if (state.durableMessages().length >= 100) throw new CommandRefusedError('Queue is full', 'daemon');
  const prepared = await prepareSubmission(queue, command);
  if (prepared === undefined) return false;
  const id = queue.record.nextId();
  const pending = submissionPayload(prepared, id, name);
  // A bad item would stay queued and make every later save fail, so it is rejected before the queue changes.
  try { validateItem(pending); } catch (error) { throw new CommandRefusedError(error instanceof Error ? error.message : String(error), 'daemon'); }
  const runsAtOnce = queue.runsAtOnce(text(pending, 'message'));
  if (name === 'follow_up' && state.activeGoal() && !runsAtOnce) {
    await keep(queue, pending, 'afterGoal');
    return null;
  }
  if (state.held && !runsAtOnce) {
    await keep(queue, pending, 'held');
    return null;
  }
  await saveSubmission(queue, id, pending);
  let result: any;
  let failure: unknown;
  let failed = false;
  try { result = await queue.deliver(pending, true); } catch (error) { failure = error; failed = true; }
  const rejected = failed && state.failedSubmission(id);
  state.sending.delete(id);
  await queue.reportStorageError(() => queue.publish());
  if (failed && !rejected) {
    await queue.reportStorageError(() => { throw failure; });
    return null;
  }
  if (failed) throw failure;
  return result;
}

async function prepareSubmission(queue: QueueDelivery, original: any): Promise<any | undefined> {
  if (!goalSubmission(original)) return original;
  const command = clone(original);
  const request: any = { type: 'prepare_goal_prompt', message: command.message ?? null };
  for (const field of ['images', 'goalSubmissionId']) if (command[field] !== undefined) request[field] = clone(command[field]);
  const prepared = await queue.execute(request);
  if (prepared === false) return undefined;
  if (typeof prepared?.message !== 'string') throw new CommandRefusedError('Goal prompt preparation did not produce an objective', 'daemon');
  command.message = prepared.message;
  command.goalSubmissionId = prepared.goalSubmissionId ?? null;
  command.goalPrepared = true;
  delete command.images;
  return command;
}

/**
 * Adds an item that stays out of Pi's queue. A follow-up below the active goal's entry (afterGoal) waits until it moves above the goal or the goal stops.
 * An item of a held queue (held) waits until the user resumes the queue.
 */
async function keep(queue: QueueDelivery, pending: any, reason: 'afterGoal' | 'held'): Promise<void> {
  const state = queue.state;
  pending[reason] = true;
  state.pending.push(clone(pending));
  try { await queue.record.persist(); } catch (error) { state.markRetry([pending]); await queue.reportStorageError(() => queue.publish()); throw error; }
  await queue.reportStorageError(() => queue.publish());
}

async function saveSubmission(queue: QueueDelivery, id: string, pending: any): Promise<void> {
  const state = queue.state;
  if (durableMessages(state).length >= 100) throw new CommandRefusedError('Queue is full', 'daemon');
  state.pending.push(clone(pending));
  state.sending.add(id);
  try { await queue.record.persist(); } catch (error) {
    state.sending.delete(id);
    for (const item of [...state.pending, ...state.retained]) {
      if (item.id === id) item.retry = true;
    }
    const view = state.publish();
    queue.record.setView(view);
    queue.announce(clone(view));
    throw error;
  }
}
