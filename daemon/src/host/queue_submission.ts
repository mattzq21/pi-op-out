import { clone, text } from './json';
import { CommandRefusedError } from '../pi_rejection';
import { validateItem } from './queue_storage';
import { durableMessages, sortHeld } from './queue_state';
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
 * Adds a steer or follow-up message to the queue and sends it to Pi, unless the queue is paused.
 * Returns null for an item kept while paused, or an item kept for retry after a failure.
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
  if (await saveSubmission(queue, id, pending)) {
    await queue.reportStorageError(() => queue.publish());
    return null;
  }
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

/** Sends a prompt while the queue is paused, as a follow-up that Pi discards when it rejects it. */
export async function executeHeldPrompt(queue: QueueDelivery, original: any): Promise<any> {
  const state = queue.state;
  if (durableMessages(state).length >= 100) throw new CommandRefusedError('Queue is full', 'daemon');
  const command = clone(original);
  const id = queue.record.nextId();
  const item: any = { id, message: command.message ?? null, behavior: 'followUp', deliveryStarted: true };
  if (command.images !== undefined) item.images = clone(command.images);
  if (command.goalSubmissionId !== undefined) item.goalSubmissionId = command.goalSubmissionId;
  command.type = 'queue_prompt';
  command.queueId = id;
  command.streamingBehavior = 'followUp';
  command.discardOnRejection = true;
  state.pending.push(item);
  state.sending.add(id);
  let result: any;
  try { await queue.record.retain(item); result = await queue.execute(command); } catch (error) {
    state.failedSubmission(id);
    state.sending.delete(id);
    await queue.reportStorageError(() => queue.publish());
    throw error;
  } finally { state.sending.delete(id); }
  if (result?.disposition === 'handled') await queue.consumed(id);
  await queue.publish();
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

async function saveSubmission(queue: QueueDelivery, id: string, pending: any): Promise<boolean> {
  const state = queue.state;
  if (durableMessages(state).length >= 100) throw new CommandRefusedError('Queue is full', 'daemon');
  state.pending.push(clone(pending));
  const held = state.held !== null;
  if (state.held) {
    state.held.push(clone(pending));
    sortHeld(state.held);
  } else state.sending.add(id);
  try { await queue.record.persist(); } catch (error) {
    state.sending.delete(id);
    for (const item of [...state.pending, ...state.retained, ...state.heldItems()]) {
      if (item.id === id) item.retry = true;
    }
    const view = state.publish();
    queue.record.setView(view);
    queue.announce(clone(view));
    throw error;
  }
  return held;
}
