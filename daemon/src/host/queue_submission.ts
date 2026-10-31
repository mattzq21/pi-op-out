import { randomUUID } from 'node:crypto';
import { clone, text } from './json';
import { CommandRefusedError } from '../pi_rejection';
import { validateItem } from './queue_storage';
import type { QueueDelivery } from './queue_delivery';

export { queuedCommand } from '../plugin_contributions';

/** The images with an id each. The queue view leaves image data out, so clients tell images apart by id after an edit. Pi does not get the ids. */
export function withImageIds(images: any[]): any[] {
  return images.map(image => image && typeof image === 'object' && typeof image.id === 'string' ? clone(image) : { ...clone(image), id: randomUUID() });
}

function submissionPayload(command: any, id: string, name: string): any {
  const pending: any = { id, message: command.message ?? null, behavior: name === 'steer' ? 'steer' : 'followUp' };
  for (const field of ['images', 'goalSubmissionId', 'preparedGoal']) if (command[field] !== undefined) pending[field] = clone(command[field]);
  if (Array.isArray(pending.images)) pending.images = withImageIds(pending.images);
  return pending;
}

/**
 * Adds a steer or follow-up message to the queue. Pi takes it when it is ready for it.
 * A command that Pi runs at once never waits: it goes to Pi now.
 */
export async function enqueue(queue: QueueDelivery, command: any, name: string): Promise<any> {
  const state = queue.state;
  if (state.durableMessages().length >= 100) throw new CommandRefusedError('Queue is full', 'daemon');
  const id = queue.record.nextId();
  const item = submissionPayload(command, id, name);
  // A bad item would stay queued and make every later save fail, so it is rejected before the queue changes.
  try { validateItem(item); } catch (error) { throw new CommandRefusedError(error instanceof Error ? error.message : String(error), 'daemon'); }
  // A goal objective waits like any message.
  if (!item.preparedGoal && queue.runsAtOnce(text(item, 'message'))) return runAtOnce(queue, item);
  // A goal that waits for the user's first message cannot start, so the message goes before it.
  if (name === 'follow_up' && state.queuedGoal() && !state.goals.waitingForInput) item.afterGoal = true;
  // After the user stopped a response, the next message goes before the messages that waited.
  if (state.stopped && !item.afterGoal) { state.stopped = false; state.pending.unshift(item); } else state.pending.push(item);
  try { await queue.publish(); } catch (error) {
    state.markRetry([item]);
    await queue.reportStorageError(() => queue.publish());
    throw error;
  }
  return { disposition: 'queued' };
}

/** Sends a command that Pi runs at once. Its saved copy goes when Pi handled it; a command that failed in another way is kept for retry. */
async function runAtOnce(queue: QueueDelivery, item: any): Promise<any> {
  const state = queue.state;
  const id = text(item, 'id');
  state.pending.push(clone(item));
  let result: any;
  try { result = await queue.deliver(item, true); } catch (error) {
    if (state.rejected.delete(id)) { await queue.reportStorageError(() => queue.publish()); throw error; }
    state.markRetry([item]);
    await queue.reportStorageError(() => queue.publish());
    await queue.reportStorageError(() => { throw error; });
    return null;
  }
  await queue.reportStorageError(() => queue.publish());
  return result;
}
