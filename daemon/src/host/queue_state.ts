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

/** The queue as the daemon sees it: items it keeps, items Pi holds, and items held back while paused. */
export class QueueState {
  pending: any[] = [];
  retained: any[] = [];
  held: any[] | null = null;
  steering: any[] = [];
  followUp: any[] = [];
  changing = false;
  clearing = false;
  sending = new Set<string>();
  rejected = new Set<string>();
  awaitingSteering: any[] = [];
  steeringTimestamps = new Set<string>();
  inferenceRevision = 0;

  heldItems(): any[] { return this.held ?? []; }

  durableMessages(): any[] {
    this.retained = durableMessages(this);
    return this.retained;
  }

  remove(id: string): void {
    this.pending = this.pending.filter(item => item.id !== id);
    this.retained = this.retained.filter(item => item.id !== id);
    if (this.held) this.held = this.held.filter(item => item.id !== id);
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
    for (const item of this.heldItems().filter(item => !flag(item, 'retry'))) {
      if (item.behavior === 'steer') steering.push(clone(item.message ?? null));
      else if (item.behavior === 'followUp') followUp.push(clone(item.message ?? null));
    }
    const visible = pending.map(original => {
      const item = clone(original);
      if (item && typeof item === 'object' && !Array.isArray(item)) for (const field of CONSUMPTION_FIELDS) delete item[field];
      if (Array.isArray(item?.images)) for (const image of item.images) if (image && typeof image === 'object' && !Array.isArray(image)) delete image.data;
      return item;
    });
    return { type: 'queue_update', steering, followUp, pendingMessages: visible };
  }

  publish(): any {
    const heldIds = new Set(this.heldItems().map(item => text(item, 'id')));
    let available = this.pending.filter(item => !heldIds.has(text(item, 'id')));
    for (const behavior of ['steer', 'followUp']) {
      const texts = this.texts(behavior);
      for (const message of unique(texts)) {
        const matches = available.filter(item => !flag(item, 'retry') && !this.sending.has(text(item, 'id')) && item.behavior === behavior && jsonEqual(item.message, message))
          .map(item => text(item, 'id'));
        const stale = new Set(matches.slice(0, Math.max(0, matches.length - count(texts, message))));
        available = available.filter(item => !stale.has(text(item, 'id')));
      }
    }
    const pending: any[] = [];
    for (const behavior of ['steer', 'followUp']) {
      for (const message of this.texts(behavior)) {
        const index = available.findIndex(item => !flag(item, 'retry') && item.behavior === behavior && jsonEqual(item.message, message));
        if (index >= 0) pending.push(available.splice(index, 1)[0]);
      }
    }
    pending.push(...this.heldItems());
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

  failedHeld(): any {
    const held = this.held ?? [];
    this.held = null;
    for (const item of held) item.retry = true;
    this.pending = this.pending.filter(item => !held.some(saved => saved.id === item.id));
    this.pending.push(...held);
    return this.publish();
  }

  /** Throws when pausing would lose attachments of messages that Pi has but this queue does not. */
  assertHoldable(): void {
    for (const behavior of ['steer', 'followUp']) {
      for (const message of this.texts(behavior)) {
        const saved = this.pending.filter(item => !flag(item, 'retry') && item.behavior === behavior && jsonEqual(item.message, message)).length;
        if (saved < count(this.texts(behavior), message)) {
          throw new Error('Cannot preserve all queued attachments while pausing. Wait for messages sent outside this window to finish first.');
        }
      }
    }
  }

}

export function durableMessages(state: QueueState): any[] {
  const retained: any[] = [];
  for (const item of [...state.pending, ...state.heldItems()]) updateItem(retained, item);
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

export function sortHeld(held: any[]): void { held.sort((left, right) => Number(left.behavior === 'followUp') - Number(right.behavior === 'followUp')); }

/** Matches the messages that Pi gave back on pause to the original items, so their attachments stay. */
export function heldMessages(cleared: any, originals: any[], nextId: () => string): any[] {
  const held: any[] = [];
  for (const [field, behavior] of [['steering', 'steer'], ['followUp', 'followUp']]) {
    const texts = array(cleared, field);
    const matches = new Map<string, any[]>();
    for (const message of texts) {
      const total = count(texts, message);
      const candidates = originals.filter(item => !flag(item, 'retry') && item.behavior === behavior && jsonEqual(item.message, message)).reverse().slice(0, total).map(clone);
      matches.set(key(message), candidates);
    }
    for (const message of texts) {
      const original = matches.get(key(message))?.pop();
      held.push(original ?? { id: nextId(), message, behavior, retry: true });
    }
  }
  return held;
}
