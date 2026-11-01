import { randomUUID } from 'node:crypto';
import { clone, text } from './json';
import { CommandRefusedError } from '../pi_rejection';
import { validateItem } from './queue_storage';
import type { QueueDelivery } from './queue_delivery';

export { queuedCommand } from '../plugin_contributions';

export function withImageIds(images: any[]): any[] {
  return images.map(image => image && typeof image === 'object' && typeof image.id === 'string' ? clone(image) : { ...clone(image), id: randomUUID() });
}

function submissionPayload(command: any, id: string, name: string): any {
  const pending: any = { id, message: command.message ?? null, behavior: name === 'steer' ? 'steer' : 'followUp' };
  for (const field of ['images', 'goalSubmissionId', 'preparedGoal']) if (command[field] !== undefined) pending[field] = clone(command[field]);
  if (Array.isArray(pending.images)) pending.images = withImageIds(pending.images);
  return pending;
}

export async function enqueue(queue: QueueDelivery, command: any, name: string): Promise<any> {
  const state = queue.state;
  if (state.durableMessages().length >= 100) throw new CommandRefusedError('Queue is full', 'daemon');
  const id = queue.record.nextId();
  const item = submissionPayload(command, id, name);
  try { validateItem(item); } catch (error) { throw new CommandRefusedError(error instanceof Error ? error.message : String(error), 'daemon'); }
  if (!item.preparedGoal && queue.runsAtOnce(text(item, 'message'))) return runAtOnce(queue, item);
  if (name === 'follow_up' && state.queuedGoal() && !state.goals.waitingForInput) item.afterGoal = true;
  if (state.stopped && !item.afterGoal) { state.stopped = false; state.pending.unshift(item); } else state.pending.push(item);
  try { await queue.publish(); } catch (error) {
    state.markRetry([item]);
    await queue.reportStorageError(() => queue.publish());
    throw error;
  }
  return { disposition: 'queued' };
}

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
