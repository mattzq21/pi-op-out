import { array, clone, flag, jsonEqual, text } from './json';
import type { Mutex } from '../util/sync';
import { GOAL_ENTRY_ID, kept, unique, type QueueState } from './queue_state';
import type { QueueDelivery } from './queue_delivery';
import { commandName } from '../plugin_contributions';
import { queuedCommand } from './queue_submission';

/**
 * Changes one pending item: removes it, edits its text, switches it between steer and follow-up, moves it, or sends it again.
 * Items that Pi holds are taken back from Pi and sent again in the new order.
 */
export async function changePending(queue: QueueDelivery, gate: Mutex, id: string, action: any, assertOwner: () => void): Promise<any> {
  assertOwner();
  if (isEdit(action)) {
    const release = await gate.lock();
    try { assertOwner(); return await editPending(queue, id, action.message); } finally { release(); }
  }
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
    if (queue.state.held) return await changeHeld(queue, id, action);
    const waiting = queue.state.pending.find(item => item.id === id && flag(item, 'afterGoal') && !flag(item, 'retry'));
    if (waiting && (action === 'remove' || action === 'steer' || action === 'followUp')) return await changeWaiting(queue, waiting, action);
    if (movesAroundGoal(queue.state, id, action)) return await moveAroundGoal(queue, id, action);
    const change = pendingChange(queue, id, action);
    if (!change) return null;
    const { target, behavior, neighbor } = change;
    if (action === 'steer' && queuedCommand(text(target, 'message'))) throw new Error('/' + commandName(text(target, 'message')) + ' can only be queued as a follow-up');
    assertOwner();
    if (cancelling) return await changeLive(queue, id, 'remove', undefined, action);
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

async function retry(queue: QueueDelivery, id: string, target: any, behavior: string): Promise<any> {
  const state = queue.state;
  if (behavior === 'remove') {
    state.remove(id);
    await queue.record.persist();
    await queue.publish();
    return null;
  }
  target.retry = false;
  delete target.held;
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

/** An edit of a queued message's text: { type: 'edit', message }. */
function isEdit(action: any): action is { type: 'edit'; message: string } {
  return action !== null && typeof action === 'object' && !Array.isArray(action) && action.type === 'edit';
}

/**
 * Replaces the text of a queued message. Messages that the daemon keeps (waiting below the goal, or kept for retry) change in place. A message in Pi's queue is taken back with the rest of that queue and sent again with the new text.
 */
async function editPending(queue: QueueDelivery, id: string, message: unknown): Promise<any> {
  const state = queue.state;
  const target = state.pending.find(item => item.id === id);
  if (!target) throw new Error('This message is no longer in the queue.');
  if (typeof message !== 'string') throw new Error('The edited message must be text.');
  if (state.sending.has(id)) throw new Error('This message is being sent and can no longer be edited.');
  if (target.goalSubmissionId !== undefined) throw new Error('A goal message cannot be edited here. Use /goal edit.');
  if (!message.trim() && !(Array.isArray(target.images) && target.images.length)) throw new Error('A queued message cannot be empty. Remove it instead.');
  if (target.behavior === 'steer' && queuedCommand(message)) throw new Error('/' + commandName(message) + ' can only be queued as a follow-up');
  if (jsonEqual(target.message, message)) return null;
  if (flag(target, 'retry') || kept(target)) {
    target.message = message;
    await queue.record.persist();
    await queue.publish();
    return null;
  }
  return changeLive(queue, id, 'edit', undefined, { type: 'edit', message });
}

async function changeLive(queue: QueueDelivery, id: string, behavior: string, neighbor: string | undefined, action: any): Promise<any> {
  const state = queue.state;
  const snapshot = [...state.steering, ...state.followUp];
  if (unique(snapshot).length !== snapshot.length || snapshot.some(message => !state.pending.some(item => !flag(item, 'retry') && !flag(item, 'afterGoal') && jsonEqual(item.message, message)))) {
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
  const remaining = clearedMessages(cleared, originals.filter(item => !flag(item, 'afterGoal')), id, behavior, () => queue.record.nextId());
  if (neighbor !== undefined) moveItem(remaining, id, neighbor, action);
  if (behavior === 'edit') for (const item of remaining) if (item.id === id) item.message = action.message;
  let rest = remaining;
  if (behavior === 'remove') {
    rest = remaining.filter(item => item.id !== id);
    await queue.record.forget(id);
  }
  state.pending = [...originals.filter(item => flag(item, 'retry')), ...clone(rest), ...originals.filter(item => flag(item, 'afterGoal') && !flag(item, 'retry'))];
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

/** Removes a follow-up that waits below the goal, or makes it a steering message, which goes to Pi at once. */
async function changeWaiting(queue: QueueDelivery, item: any, action: string): Promise<any> {
  const state = queue.state;
  if (action === 'followUp') return null;
  if (action === 'remove') {
    await queue.record.forget(text(item, 'id'));
    await queue.publish();
    return null;
  }
  if (queuedCommand(text(item, 'message'))) throw new Error('/' + commandName(text(item, 'message')) + ' can only be queued as a follow-up');
  item.afterGoal = false;
  item.behavior = 'steer';
  await queue.record.persist();
  try { await queue.deliver(item, false); } catch (error) { state.markRetry([item]); await queue.publish(); throw error; }
  await queue.publish();
  return null;
}

/** True for a move of the goal entry, and for any follow-up move while a goal is active, because the goal entry is one of the follow-ups. */
function movesAroundGoal(state: QueueState, id: string, action: any): boolean {
  if (!state.queuedGoal()) return false;
  const moving = action === 'moveUp' || action === 'moveDown' || (action !== null && typeof action === 'object' && !Array.isArray(action));
  if (!moving) return false;
  if (id === GOAL_ENTRY_ID) return true;
  const item = state.pending.find(entry => entry.id === id);
  return item !== undefined && item.behavior === 'followUp' && !flag(item, 'retry');
}

/** The follow-up order with the goal entry moved, or undefined when the move changes nothing. */
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

/**
 * Moves the goal entry or a follow-up. Follow-ups that end above the goal are in Pi's queue; the rest wait in the daemon.
 * Pi's queue changes only as far as the move needs: not at all, by sending follow-ups that came up past the goal,
 * or by taking its queue back and sending it again in the new order.
 */
async function moveAroundGoal(queue: QueueDelivery, id: string, action: any): Promise<any> {
  const state = queue.state;
  const followUps = state.pending.filter(item => item.behavior === 'followUp' && !flag(item, 'retry'));
  const ahead = followUps.filter(item => !flag(item, 'afterGoal')).map(item => text(item, 'id'));
  const behind = followUps.filter(item => flag(item, 'afterGoal')).map(item => text(item, 'id'));
  const order = movedOrder([...ahead, GOAL_ENTRY_ID, ...behind], id, action);
  if (!order) return null;
  const split = order.indexOf(GOAL_ENTRY_ID);
  const nextAhead = order.slice(0, split);
  const nextBehind = order.slice(split + 1);
  const byId = new Map(followUps.map(item => [text(item, 'id'), item]));
  const wait = (item: any) => { item.afterGoal = true; item.deliveryStarted = false; item.consumedTimestamp = null; item.consumedContent = null; item.consumedInputId = null; };
  const arrange = () => {
    for (const entry of nextBehind) wait(byId.get(entry));
    for (const entry of nextBehind) delete byId.get(entry).held;
    for (const entry of nextAhead) { byId.get(entry).afterGoal = false; if (state.held) byId.get(entry).held = true; }
    state.pending = [...state.pending.filter(item => !nextBehind.includes(text(item, 'id'))), ...nextBehind.map(entry => byId.get(entry))];
  };
  const sameStart = ahead.every((entry, index) => nextAhead[index] === entry);
  if (state.held) {
    arrange();
    await queue.record.persist();
    await queue.publish();
    return null;
  }
  if (sameStart) {
    const added = nextAhead.slice(ahead.length).map(entry => byId.get(entry));
    arrange();
    await queue.record.persist();
    for (let index = 0; index < added.length; index += 1) {
      try { await queue.deliver(added[index], false); } catch (error) { state.markRetry(added.slice(index)); await queue.publish(); throw error; }
    }
    await queue.publish();
    return null;
  }
  return regroupLive(queue, nextAhead, nextBehind, byId);
}

/** Takes Pi's queue back and sends steering messages and the follow-ups above the goal again, in their new order. */
async function regroupLive(queue: QueueDelivery, nextAhead: string[], nextBehind: string[], byId: Map<string, any>): Promise<any> {
  const state = queue.state;
  const snapshot = [...state.steering, ...state.followUp];
  if (unique(snapshot).length !== snapshot.length || snapshot.some(message => !state.pending.some(item => !flag(item, 'retry') && !flag(item, 'afterGoal') && jsonEqual(item.message, message)))) {
    throw new Error('This queue contains messages that cannot be safely moved. Use Ctrl+Enter to steer a new message.');
  }
  state.changing = true;
  const originals = clone(state.pending);
  try {
    const cleared = await queue.execute({ type: 'clear_queue' });
    const returned = clearedMessages(cleared, originals.filter(item => !flag(item, 'afterGoal')), '', 'reorder', () => queue.record.nextId());
    const steering = returned.filter(item => item.behavior === 'steer');
    const known = new Set([...nextAhead, ...nextBehind]);
    const unknown = returned.filter(item => item.behavior === 'followUp' && !known.has(text(item, 'id'))).map(item => ({ ...item, retry: true }));
    const ahead = nextAhead.map(entry => ({ ...clone(byId.get(entry)), afterGoal: false }));
    const behind = nextBehind.map(entry => ({ ...clone(byId.get(entry)), afterGoal: true, deliveryStarted: false, consumedTimestamp: null, consumedContent: null, consumedInputId: null }));
    state.pending = [...originals.filter(item => flag(item, 'retry')), ...steering, ...ahead, ...behind, ...unknown];
    const resend = [...steering, ...ahead];
    try { await queue.record.persist(); } catch (error) { state.markRetry(resend); throw error; }
    if (unknown.length) {
      state.markRetry(resend);
      throw new Error('Another source changed the queue while moving. Pending text has been kept for retry.');
    }
    for (let index = 0; index < resend.length; index += 1) {
      try { await queue.deliver(resend[index], false); } catch (error) { state.markRetry(resend.slice(index)); throw error; }
    }
    return null;
  } finally { state.changing = false; await queue.publish(); }
}

/** Clears the fields that record a delivery to Pi, for an item that the daemon keeps again. */
function undelivered(item: any): any {
  return { ...item, deliveryStarted: false, consumedTimestamp: null, consumedContent: null, consumedInputId: null };
}

/**
 * Puts the queue on hold. Pi's queue is taken back, and its items stay with the daemon until resumeQueue.
 * Pi messages that the daemon did not send stay in the queue for retry.
 */
export async function holdQueue(queue: QueueDelivery): Promise<void> {
  const state = queue.state;
  await queue.record.saveHeld(true);
  try { await queue.tellHeld(true); } catch (error) { await queue.record.saveHeld(false); throw error; }
  if (!state.steering.length && !state.followUp.length) {
    state.held = true;
    await queue.publish();
    return;
  }
  state.changing = true;
  const originals = clone(state.pending);
  try {
    let cleared: any;
    try { cleared = await queue.execute({ type: 'clear_queue' }); } catch (error) {
      await queue.record.saveHeld(false);
      await queue.tellHeld(false);
      throw error;
    }
    const live = originals.filter(item => !flag(item, 'retry') && !kept(item));
    const returned: any[] = [];
    for (const [field, behavior] of [['steering', 'steer'], ['followUp', 'followUp']]) {
      for (const message of array(cleared, field)) {
        const index = live.findIndex(item => item.behavior === behavior && jsonEqual(item.message, message));
        returned.push(index >= 0 ? { ...undelivered(live.splice(index, 1)[0]), held: true } : { id: queue.record.nextId(), message, behavior, retry: true });
      }
    }
    state.held = true;
    state.pending = [...originals.filter(item => flag(item, 'retry')), ...returned.filter(item => !flag(item, 'retry')), ...originals.filter(item => flag(item, 'afterGoal') && !flag(item, 'retry')), ...returned.filter(item => flag(item, 'retry'))];
    await queue.record.persist();
  } finally { state.changing = false; await queue.publish(); }
}

/**
 * Ends the hold and sends the held items to Pi: steering messages first, then follow-ups, each in queue order.
 * Pi hears that the hold ended only after they are in its queue, so the goal cannot start ahead of them.
 */
export async function resumeQueue(queue: QueueDelivery): Promise<void> {
  const state = queue.state;
  await queue.record.saveHeld(false);
  const held = state.heldItems();
  const send = [...held.filter(item => item.behavior === 'steer'), ...held.filter(item => item.behavior !== 'steer')];
  state.held = false;
  for (const item of state.pending) delete item.held;
  try {
    try { await queue.record.persist(); } catch (error) { state.markRetry(send); throw error; }
    for (let index = 0; index < send.length; index += 1) {
      try { await queue.deliver(send[index], false); } catch (error) { state.markRetry(send.slice(index)); throw error; }
    }
  } finally {
    await queue.publish();
    await queue.tellHeld(false);
  }
}

/** Changes an item while the queue is on hold. Nothing goes to Pi: the item changes in place and stays with the daemon. */
async function changeHeld(queue: QueueDelivery, id: string, action: any): Promise<any> {
  const state = queue.state;
  if (movesAroundGoal(state, id, action)) return moveAroundGoal(queue, id, action);
  const target = state.pending.find(item => item.id === id);
  if (!target) return null;
  if (action === 'remove') {
    await queue.record.forget(id);
    await queue.publish();
    return null;
  }
  if (action === 'steer' || action === 'followUp') {
    if (action === 'steer' && queuedCommand(text(target, 'message'))) throw new Error('/' + commandName(text(target, 'message')) + ' can only be queued as a follow-up');
    if (!flag(target, 'retry') && !flag(target, 'afterGoal') && target.behavior === action) return null;
    const index = state.pending.indexOf(target);
    state.pending[index] = { ...undelivered(target), behavior: action, held: true, retry: false, afterGoal: false };
  } else {
    const change = pendingChange(queue, id, action);
    if (!change || change.neighbor === undefined) return null;
    moveItem(state.pending, id, change.neighbor, action);
  }
  await queue.record.persist();
  await queue.publish();
  return null;
}
