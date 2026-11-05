import { randomUUID } from 'node:crypto';
import { clone, flag, jsonEqual, text } from '../json';
import type { QueueGate } from './gate';
import { GOAL_ENTRY_ID, type QueueState } from './state';
import { piImages, type QueueDelivery } from './delivery';
import { commandName } from '../../plugins';
import { queuedCommand, withImageIds } from './submission';
import { activateGoal, goalArgument, goalSubmission, prepareGoal } from '../goals/commands';

export async function changePending(queue: QueueDelivery, gate: QueueGate, id: string, action: any, assertOwner: () => void): Promise<any> {
  const release = await gate.lock();
  try {
    assertOwner();
    const state = queue.state;
    if (movesAroundGoal(state, id, action)) return await moveAroundGoal(queue, id, action);
    const target = state.pending.find(item => item.id === id);
    if (!target) return isEdit(action) ? Promise.reject(new Error('This message is no longer in the queue.')) : null;
    if (flag(target, 'taken') || state.sending.has(id)) throw new Error('This message is being sent and can no longer be changed.');
    if (isEdit(action)) return await editPending(queue, target, action);
    if (action === 'remove') {
      await queue.record.forget(id);
      await queue.publish();
      return null;
    }
    if (action === 'steer' || action === 'followUp') {
      if (action === 'steer' && queuedCommand(text(target, 'message'))) throw new Error('/' + commandName(text(target, 'message')) + ' can only be queued as a follow-up');
      if (!flag(target, 'retry') && !flag(target, 'afterGoal') && target.behavior === action) return null;
      clearDelivery(target);
      target.behavior = action;
      delete target.retry;
      if (action === 'steer') delete target.afterGoal;
    } else {
      const neighbor = queueNeighbor(state.pending, target, action);
      if (neighbor === undefined) return null;
      moveItem(state.pending, id, neighbor, action);
    }
    await queue.publish();
    return null;
  } finally { release(); }
}

function clearDelivery(item: any): void {
  delete item.used;
  item.deliveryStarted = false;
  item.consumedTimestamp = null;
  item.consumedContent = null;
  item.consumedInputId = null;
}

function isEdit(action: any): action is { type: 'edit'; message: unknown; images?: unknown } {
  return action !== null && typeof action === 'object' && !Array.isArray(action) && action.type === 'edit';
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function editedImages(current: any[], change: unknown): any[] {
  if (change === undefined) return clone(current);
  const edit = change as any;
  if (!edit || typeof edit !== 'object' || !Array.isArray(edit.keep) || !Array.isArray(edit.add)) throw new Error('The edited images must list the images to keep and to add.');
  const keep: unknown[] = edit.keep;
  if (keep.some(index => !Number.isInteger(index) || (index as number) < 0 || (index as number) >= current.length) || new Set(keep).size !== keep.length) throw new Error('The edited images name an image that the message does not have.');
  const added = edit.add.map((image: any) => {
    if (typeof image?.data !== 'string' || !image.data || typeof image?.mimeType !== 'string' || !IMAGE_TYPES.has(image.mimeType)) throw new Error('An added image must be PNG, JPEG, GIF or WebP data.');
    return { type: 'image', data: image.data, mimeType: image.mimeType, ...(typeof image.name === 'string' ? { name: image.name } : {}) };
  });
  return [...keep.map(index => clone(current[index as number])), ...withImageIds(added)];
}

async function editPending(queue: QueueDelivery, target: any, action: { message: unknown; images?: unknown }): Promise<any> {
  const message = action.message;
  if (typeof message !== 'string') throw new Error('The edited message must be text.');
  if (commandName(text(target, 'message')) === 'compact') throw new Error('A queued /compact cannot be edited. Remove it and queue a new one.');
  const current = Array.isArray(target.images) ? target.images : [];
  const images = editedImages(current, action.images);
  if (!message.trim() && !images.length) throw new Error('A queued message cannot be empty. Remove it instead.');
  if (target.behavior === 'steer' && queuedCommand(message)) throw new Error('/' + commandName(message) + ' can only be queued as a follow-up');
  if (jsonEqual(target.message, message) && jsonEqual(current, images)) return null;
  const update: any = { message, images };
  if (goalSubmission({ message })) {
    if (images.length) throw new Error('Goals do not accept attachments. Remove the files and images before saving.');
    const prepared = await prepareGoal(queue, goalArgument(message)!);
    if (prepared === undefined) throw new Error('The goal was not prepared, so the message was not changed.');
    Object.assign(update, prepared);
  } else if (goalArgument(message) !== undefined) throw new Error('Only a goal objective can wait in the queue. Send /goal ' + goalArgument(message) + ' as a new message.');
  else update.preparedGoal = undefined;
  Object.assign(target, clone(update));
  if (!target.images.length) delete target.images;
  if (!target.preparedGoal) delete target.preparedGoal;
  await queue.publish();
  return null;
}

function queueNeighbor(pending: any[], target: any, action: any): string | undefined {
  const id = target.id;
  if (flag(target, 'retry')) return undefined;
  const peers = pending.filter(item => !flag(item, 'retry') && !flag(item, 'taken') && jsonEqual(item.behavior, target.behavior));
  if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
    const found = peers.find(item => jsonEqual(item.id, action.targetId) && !jsonEqual(item.id, id));
    return found ? text(found, 'id') : undefined;
  }
  if (action !== 'moveUp' && action !== 'moveDown') return undefined;
  const index = peers.findIndex(item => jsonEqual(item.id, id));
  if (index < 0) return undefined;
  const neighbor = action === 'moveUp' ? index - 1 : index + 1;
  if (neighbor < 0 || neighbor >= peers.length) return undefined;
  return text(peers[neighbor], 'id');
}

function moveItem(items: any[], id: string, neighbor: string, action: any): void {
  const from = items.findIndex(item => item.id === id);
  const to = items.findIndex(item => item.id === neighbor);
  if (from < 0 || to < 0) return;
  if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
    const [item] = items.splice(from, 1);
    const destination = items.findIndex(entry => entry.id === neighbor);
    items.splice(destination + (action.edge === 'after' ? 1 : 0), 0, item);
  } else {
    [items[from], items[to]] = [items[to], items[from]];
  }
}

function movesAroundGoal(state: QueueState, id: string, action: any): boolean {
  if (!state.queuedGoal()) return false;
  const moving = action === 'moveUp' || action === 'moveDown' || (action !== null && typeof action === 'object' && !Array.isArray(action) && action.type !== 'edit');
  if (!moving) return false;
  if (id === GOAL_ENTRY_ID) return true;
  const item = state.pending.find(entry => entry.id === id);
  return item !== undefined && item.behavior === 'followUp' && !flag(item, 'retry') && !flag(item, 'taken');
}

function movedOrder(order: string[], id: string, action: any): string[] | undefined {
  const next = [...order];
  const from = next.indexOf(id);
  if (from < 0) return undefined;
  if (action === 'moveUp' || action === 'moveDown') {
    const to = action === 'moveUp' ? from - 1 : from + 1;
    if (to < 0 || to >= next.length) return undefined;
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  }
  if (action.targetId === id || !next.includes(action.targetId)) return undefined;
  next.splice(from, 1);
  next.splice(next.indexOf(action.targetId) + (action.edge === 'after' ? 1 : 0), 0, id);
  return next.every((entry, index) => entry === order[index]) ? undefined : next;
}

async function moveAroundGoal(queue: QueueDelivery, id: string, action: any): Promise<any> {
  const state = queue.state;
  const followUps = state.pending.filter(item => item.behavior === 'followUp' && !flag(item, 'retry') && !flag(item, 'taken'));
  const ahead = followUps.filter(item => !flag(item, 'afterGoal')).map(item => text(item, 'id'));
  const behind = followUps.filter(item => flag(item, 'afterGoal')).map(item => text(item, 'id'));
  const order = movedOrder([...ahead, GOAL_ENTRY_ID, ...behind], id, action);
  if (!order) return null;
  const split = order.indexOf(GOAL_ENTRY_ID);
  const byId = new Map(followUps.map(item => [text(item, 'id'), item]));
  order.forEach((entry, index) => {
    const item = byId.get(entry);
    if (!item) return;
    if (index > split) item.afterGoal = true; else delete item.afterGoal;
  });
  const moved = new Set(byId.keys());
  const others = state.pending.filter(item => !moved.has(text(item, 'id')));
  state.pending = [...others, ...order.flatMap(entry => byId.has(entry) ? [byId.get(entry)] : [])];
  await queue.publish();
  return null;
}

export async function takeNext(queue: QueueDelivery, behavior: unknown, holding: unknown): Promise<any> {
  if (behavior !== 'steer' && behavior !== 'followUp' && behavior !== 'goal') throw new Error('queue_take needs behavior steer, followUp or goal');
  const state = queue.state;
  const has = new Set(Array.isArray(holding) ? holding.filter(id => typeof id === 'string') : []);
  for (const item of state.pending) if (has.has(text(item, 'id'))) item.taken = true;
  if (behavior === 'goal') {
    if (has.size) await queue.publish();
    const ready = state.goalAvailable() && !state.pending.some(entry => state.available(entry));
    return { item: ready ? { id: GOAL_ENTRY_ID, insertion: state.goals.prompt(queue.goalPlace()) } : null, offer: queue.currentOffer() };
  }
  const item = state.pending.find(entry => entry.behavior === behavior && state.available(entry));
  if (!item) { if (has.size) await queue.publish(); return { item: null, offer: queue.currentOffer() }; }
  let context: any[] = [];
  if (item.preparedGoal) {
    try { context = [activateGoal(queue, item.preparedGoal)].filter(Boolean); } catch (error) {
      await takeFailed(queue, item.id, 'The goal could not be set: ' + (error instanceof Error ? error.message : String(error)));
      return { item: null, offer: queue.currentOffer() };
    }
  }
  item.taken = true;
  item.deliveryStarted = true;
  if (item.behavior === 'steer') state.steerTaken.add(text(item, 'id'));
  await queue.publish();
  const taken: any = { id: item.id, message: item.message, behavior: item.behavior };
  if (item.goalSubmissionId !== undefined) taken.goalSubmissionId = clone(item.goalSubmissionId);
  if (context.length) taken.context = context;
  const images = piImages(item);
  if (images) taken.images = images;
  return { item: taken, offer: queue.currentOffer() };
}

export async function releaseTaken(queue: QueueDelivery, ids: unknown): Promise<void> {
  const released = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  let changed = false;
  for (const item of queue.state.pending) {
    if (!released.has(text(item, 'id')) || !flag(item, 'taken')) continue;
    delete item.taken;
    clearDelivery(item);
    changed = true;
  }
  if (changed) await queue.publish();
}

export async function takeFailed(queue: QueueDelivery, id: unknown, error: unknown): Promise<void> {
  const item = queue.state.pending.find(entry => entry.id === id);
  const reason = typeof error === 'string' && error ? error : 'Pi could not take the message';
  if (item) { queue.state.markRetry([item]); clearDelivery(item); await queue.publish(); }
  queue.announce({ type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: 'A queued message could not be sent: ' + reason });
}
