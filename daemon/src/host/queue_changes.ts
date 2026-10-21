import { array, clone, flag, jsonEqual, text } from './json';
import type { Mutex } from '../util/sync';
import { sortHeld, unique } from './queue_state';
import type { QueueDelivery } from './queue_delivery';
import { commandName } from '../plugin_contributions';
import { queuedCommand } from './queue_submission';

/**
 * Changes one pending item: removes it, switches it between steer and follow-up, moves it, or sends it again.
 * Items that Pi holds are taken back from Pi and sent again in the new order.
 */
export async function changePending(queue: QueueDelivery, gate: Mutex, id: string, action: any, assertOwner: () => void): Promise<any> {
  assertOwner();
  const cancelling = action === 'remove' && queue.state.sending.has(id);
  let release: () => void;
  if (cancelling) {
    const [cancelled, locked] = await Promise.allSettled([queue.execute({ type: 'cancel_preparation' }), gate.lock()]);
    if (cancelled.status === 'rejected') { if (locked.status === 'fulfilled') locked.value(); throw cancelled.reason; }
    if (locked.status === 'rejected') throw locked.reason;
    release = locked.value;
  } else release = await gate.lock();
  try {
    assertOwner();
    const change = pendingChange(queue, id, action);
    if (!change) return null;
    const { target, behavior, neighbor } = change;
    if (action === 'steer' && queuedCommand(text(target, 'message'))) throw new Error('/' + commandName(text(target, 'message')) + ' can only be queued as a follow-up');
    assertOwner();
    if (cancelling) return await changeLive(queue, id, 'remove', undefined, action);
    if (changeHeld(queue, id, behavior, neighbor, action)) { await queue.publish(); return null; }
    if (flag(target, 'retry')) return await retry(queue, id, target, behavior);
    return await changeLive(queue, id, behavior, neighbor, action);
  } finally { release(); }
}

function pendingChange(queue: QueueDelivery, id: string, action: any): { target: any; behavior: string; neighbor?: string } | undefined {
  const found = queue.state.pending.find(item => item.id === id);
  if (!found) return undefined;
  const target = clone(found);
  const behavior = typeof action === 'string' ? action : 'reorder';
  const moving = behavior === 'moveUp' || behavior === 'moveDown' || behavior === 'reorder';
  const neighbor = queueNeighbor(queue.state.pending, target, action, behavior);
  if (moving && (flag(target, 'retry') || neighbor === undefined)) return undefined;
  return { target, behavior, neighbor };
}

function changeHeld(queue: QueueDelivery, id: string, behavior: string, neighbor: string | undefined, action: any): boolean {
  const state = queue.state;
  const held = state.held;
  if (!held || !held.some(item => item.id === id)) return false;
  if (behavior === 'remove') state.held = held.filter(item => item.id !== id);
  else if (behavior === 'steer' || behavior === 'followUp') {
    const target = held.find(item => item.id === id);
    if (target) { target.behavior = behavior; target.retry = false; }
  } else if (neighbor !== undefined) moveItem(held, id, neighbor, action);
  sortHeld(state.held!);
  if (behavior === 'remove') state.remove(id);
  return true;
}

async function retry(queue: QueueDelivery, id: string, target: any, behavior: string): Promise<any> {
  const state = queue.state;
  if (behavior === 'remove') {
    state.remove(id);
    await queue.record.persist();
    await queue.publish();
    return null;
  }
  target.retry = false;
  target.consumedTimestamp = null;
  target.consumedContent = null;
  target.consumedInputId = null;
  target.behavior = behavior === 'steer' ? 'steer' : 'followUp';
  const index = state.pending.findIndex(item => item.id === id);
  if (index >= 0) state.pending[index] = clone(target);
  // Mark the item as sending before the save yields, so a queue update that arrives meanwhile keeps it in pending.
  state.sending.add(id);
  try { await queue.record.persist(); } catch (error) { state.sending.delete(id); state.markRetry([target]); throw error; }
  let failure: unknown;
  try { await queue.deliver(target, false); } catch (error) {
    failure = error;
    const item = state.pending.find(entry => entry.id === id);
    if (item) item.retry = true;
  }
  await queue.publish();
  if (failure !== undefined) throw failure;
  return null;
}

async function changeLive(queue: QueueDelivery, id: string, behavior: string, neighbor: string | undefined, action: any): Promise<any> {
  const state = queue.state;
  const snapshot = [...state.steering, ...state.followUp];
  if (unique(snapshot).length !== snapshot.length || snapshot.some(message => !state.pending.some(item => !flag(item, 'retry') && jsonEqual(item.message, message)))) {
    throw new Error('This queue contains messages that cannot be safely switched. Use Ctrl+Enter to steer a new message.');
  }
  state.changing = true;
  const originals = clone(state.pending);
  try { return await replaceLive(queue, id, behavior, neighbor, action, originals); }
  finally { state.changing = false; await queue.publish(); }
}

async function replaceLive(queue: QueueDelivery, id: string, behavior: string, neighbor: string | undefined, action: any, originals: any[]): Promise<any> {
  const state = queue.state;
  const cleared = await queue.execute({ type: 'clear_queue' });
  const remaining = clearedMessages(cleared, originals, id, behavior, () => queue.record.nextId());
  if (neighbor !== undefined) moveItem(remaining, id, neighbor, action);
  let rest = remaining;
  if (behavior === 'remove') {
    rest = remaining.filter(item => item.id !== id);
    await queue.record.forget(id);
  }
  state.pending = [...originals.filter(item => flag(item, 'retry')), ...clone(rest)];
  if (behavior === 'remove') state.remove(id);
  try { await queue.record.persist(); } catch (error) { state.markRetry(rest); throw error; }
  if (rest.some(item => flag(item, 'retry'))) {
    state.markRetry(rest);
    throw new Error('Another source changed the queue while switching. Pending text has been kept for retry; reattach any images from messages sent outside this window.');
  }
  for (let index = 0; index < rest.length; index += 1) {
    try { await queue.deliver(rest[index], false); } catch (error) { state.markRetry(rest.slice(index)); throw error; }
  }
  return null;
}

function clearedMessages(cleared: any, originals: any[], id: string, behavior: string, nextId: () => string): any[] {
  const remaining: any[] = [];
  for (const [field, mode] of [['steering', 'steer'], ['followUp', 'followUp']]) {
    for (const message of array(cleared, field)) {
      const original = originals.find(item => !flag(item, 'retry') && item.behavior === mode && jsonEqual(item.message, message));
      const item = original ? clone(original) : { id: nextId(), message, behavior: mode, retry: true };
      if (item.id === id && (behavior === 'steer' || behavior === 'followUp')) item.behavior = behavior;
      remaining.push(item);
    }
  }
  return remaining;
}

function queueNeighbor(pending: any[], target: any, action: any, behavior: string): string | undefined {
  const id = target.id;
  const peers = pending.filter(item => !flag(item, 'retry') && jsonEqual(item.behavior, target.behavior));
  if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
    const found = peers.find(item => jsonEqual(item.id, action.targetId) && !jsonEqual(item.id, id));
    return found ? text(found, 'id') : undefined;
  }
  if (behavior !== 'moveUp' && behavior !== 'moveDown' && behavior !== 'reorder') return undefined;
  const index = peers.findIndex(item => jsonEqual(item.id, id));
  if (index < 0) return undefined;
  const neighbor = behavior === 'moveUp' ? index - 1 : index + 1;
  if (neighbor < 0 || neighbor >= peers.length) return undefined;
  return text(peers[neighbor], 'id');
}

function moveItem(items: any[], id: string, neighbor: string, action: any): void {
  const from = items.findIndex(item => item.id === id);
  if (from < 0) return;
  const to = items.findIndex(item => item.id === neighbor);
  if (to < 0) return;
  if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
    const [item] = items.splice(from, 1);
    const destination = items.findIndex(entry => entry.id === neighbor);
    if (destination >= 0) items.splice(destination + (action.edge === 'after' ? 1 : 0), 0, item);
  } else {
    [items[from], items[to]] = [items[to], items[from]];
  }
}
