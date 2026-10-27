import { array, canon, clone, flag, jsonEqual, kind, messageText, text } from './json';

/** Fields that record how Pi took a queued item. Clients do not see them. */
export const CONSUMPTION_FIELDS = ['consumedContent', 'consumedTimestamp', 'consumedInputId', 'deliveryStarted'];

function key(value: any): string { return canon(value); }
function count(items: any[], value: any): number { return items.filter(item => jsonEqual(item, value)).length; }
export function unique(items: any[]): any[] {
  const seen = new Set<string>();
  return items.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
}
function stamp(value: any): string { return JSON.stringify(value ?? null); }

/** The id of the active goal's entry in the queue view. Queue item ids are numbers, so it does not collide with them. */
export const GOAL_ENTRY_ID = 'goal';

/** The conversation's goal as the goals extension publishes it in its piop-goal status. */
export type QueueGoal = { id: string; objective: string; active: boolean };

/** True for an item the daemon keeps out of Pi's queue: it waits below the goal, or the queue is on hold. */
export function kept(item: any): boolean { return flag(item, 'afterGoal') || flag(item, 'held'); }

/** Reads the goal from a goals extension status event: null when the goal is cleared, undefined for other events. */
export function goalStatus(event: any): QueueGoal | null | undefined {
  if (kind(event) !== 'extension_ui_request' || event.method !== 'setStatus' || event.statusKey !== 'piop-goal') return undefined;
  if (typeof event.statusText !== 'string' || !event.statusText) return null;
  const goal = JSON.parse(event.statusText);
  return { id: text(goal, 'id'), objective: text(goal, 'objective'), active: goal.status === 'active' };
}

/**
 * The queue as the daemon sees it: items it keeps and items Pi holds.
 * An active goal is an entry of the follow-up queue. Follow-ups above it are in Pi's queue and run first.
 * Follow-ups below it have afterGoal set: the daemon keeps them until they move above the goal or the goal stops.
 * While the queue is on hold, the other items have held set: the daemon keeps them until the user resumes the queue.
 */
export class QueueState {
  pending: any[] = [];
  retained: any[] = [];
  steering: any[] = [];
  followUp: any[] = [];
  changing = false;
  clearing = false;
  sending = new Set<string>();
  rejected = new Set<string>();
  awaitingSteering: any[] = [];
  steeringTimestamps = new Set<string>();
  inferenceRevision = 0;
  goal: QueueGoal | null = null;
  /** True while the user holds the queue. */
  held = false;

  activeGoal(): QueueGoal | undefined { return this.goal?.active ? this.goal : undefined; }

  /** Follow-ups below the goal entry, in queue order. */
  waiting(): any[] { return this.pending.filter(item => flag(item, 'afterGoal') && !flag(item, 'retry')); }

  /** Items kept while the queue is on hold, in queue order. */
  heldItems(): any[] { return this.pending.filter(item => flag(item, 'held') && !flag(item, 'retry')); }

  durableMessages(): any[] {
    this.retained = durableMessages(this);
    return this.retained;
  }

  remove(id: string): void {
    this.pending = this.pending.filter(item => item.id !== id);
    this.retained = this.retained.filter(item => item.id !== id);
  }

  markRetry(items: any[]): void {
    for (const pending of this.pending) if (items.some(item => item.id === pending.id)) pending.retry = true;
  }

  failedSubmission(id: string): boolean {
    if (this.rejected.delete(id)) return true;
    const saved = this.retained.find(item => item.id === id);
    if (saved) {
      const item = clone(saved);
      item.retry = true;
      this.pending = this.pending.filter(entry => entry.id !== id);
      this.pending.push(item);
    }
    return false;
  }

  texts(behavior: string): any[] { return behavior === 'steer' ? this.steering : this.followUp; }

  view(pending: any[]): any {
    const steering = clone(this.steering);
    const followUp = clone(this.followUp);
    const visible = pending.map(original => {
      const item = clone(original);
      if (item && typeof item === 'object' && !Array.isArray(item)) for (const field of CONSUMPTION_FIELDS) delete item[field];
      if (Array.isArray(item?.images)) for (const image of item.images) if (image && typeof image === 'object' && !Array.isArray(image)) delete image.data;
      return item;
    });
    const goal = this.activeGoal();
    if (goal) {
      const index = visible.findIndex(item => flag(item, 'afterGoal') || flag(item, 'retry'));
      visible.splice(index < 0 ? visible.length : index, 0, { id: GOAL_ENTRY_ID, message: goal.objective, behavior: 'followUp', goal: true });
    }
    return { type: 'queue_update', steering, followUp, pendingMessages: visible, held: this.held };
  }

  publish(): any {
    let available = [...this.pending];
    for (const behavior of ['steer', 'followUp']) {
      const texts = this.texts(behavior);
      for (const message of unique(texts)) {
        const matches = available.filter(item => !flag(item, 'retry') && !kept(item) && !this.sending.has(text(item, 'id')) && item.behavior === behavior && jsonEqual(item.message, message))
          .map(item => text(item, 'id'));
        const stale = new Set(matches.slice(0, Math.max(0, matches.length - count(texts, message))));
        available = available.filter(item => !stale.has(text(item, 'id')));
      }
    }
    const pending: any[] = [];
    for (const behavior of ['steer', 'followUp']) {
      for (const message of this.texts(behavior)) {
        const index = available.findIndex(item => !flag(item, 'retry') && !kept(item) && item.behavior === behavior && jsonEqual(item.message, message));
        if (index >= 0) pending.push(available.splice(index, 1)[0]);
      }
    }
    pending.push(...available.filter(item => flag(item, 'held') && !flag(item, 'retry')));
    pending.push(...available.filter(item => flag(item, 'afterGoal') && !flag(item, 'retry')));
    pending.push(...available.filter(item => flag(item, 'retry')));
    this.pending = [...pending, ...available.filter(item => !flag(item, 'retry') && this.sending.has(text(item, 'id')))];
    return this.view(pending);
  }

  receiveQueue(event: any): void {
    if (!this.clearing) {
      const remaining = array(event, 'steering');
      for (const message of this.steering) {
        const index = remaining.findIndex(item => jsonEqual(item, message));
        if (index >= 0) remaining.splice(index, 1); else this.awaitingSteering.push(clone(message));
      }
    }
    for (const [field, behavior] of [['steering', 'steer'], ['followUp', 'followUp']]) {
      const before = [...this.texts(behavior)];
      const added = array(event, field).filter(message => {
        const index = before.findIndex(item => jsonEqual(item, message));
        if (index >= 0) { before.splice(index, 1); return false; }
        return true;
      });
      const sending = this.pending.map((item, index) => [item, index] as const)
        .filter(([item]) => this.sending.has(text(item, 'id')) && item.behavior === behavior).map(([, index]) => index);
      if (added.length === 1 && sending.length === 1) this.pending[sending[0]].message = clone(added[0]);
    }
    this.steering = array(event, 'steering');
    this.followUp = array(event, 'followUp');
  }

  tagMessage(event: any): void {
    const name = kind(event);
    if ((name !== 'message_start' && name !== 'message_end') || event.message?.role !== 'user' || typeof event.message?.timestamp !== 'number') return;
    const timestamp = stamp(event.message.timestamp);
    if (name === 'message_start') {
      const message = messageText(event.message.content, '');
      const index = this.awaitingSteering.findIndex(item => item === message);
      const sending = this.pending.some(item => this.sending.has(text(item, 'id')) && item.behavior === 'steer' && item.message === message);
      if (index >= 0 || sending) this.steeringTimestamps.add(timestamp);
      if (index >= 0) this.awaitingSteering.splice(index, 1);
    }
    if (this.steeringTimestamps.has(timestamp)) event.message.deliveryBehavior = 'steer';
  }

  tagEntries(entries: any): void {
    for (const entry of Array.isArray(entries?.entries) ? entries.entries : []) {
      if (entry?.message?.role === 'user' && this.steeringTimestamps.has(stamp(entry.message.timestamp))) entry.message.deliveryBehavior = 'steer';
    }
  }

}

export function durableMessages(state: QueueState): any[] {
  const retained: any[] = [];
  for (const item of state.pending) updateItem(retained, item);
  for (const item of state.retained) {
    const current = retained.find(entry => entry.id === item.id);
    if (current) preserveDelivery(current, item); else retained.push(clone(item));
  }
  return retained;
}

export function updateItem(items: any[], item: any): void {
  const index = items.findIndex(saved => saved.id === item.id);
  if (index >= 0) {
    const previous = items[index];
    items[index] = clone(item);
    preserveDelivery(items[index], previous);
  } else items.push(clone(item));
}

function preserveDelivery(item: any, saved: any): void {
  for (const field of CONSUMPTION_FIELDS) {
    if (item[field] === undefined && saved?.[field] !== undefined) item[field] = clone(saved[field]);
  }
}
