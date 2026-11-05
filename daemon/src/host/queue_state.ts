import { clone, flag, kind, text } from './json';
import { GOAL_TOOL, QueueGoal } from './goals/state';

export const CONSUMPTION_FIELDS = ['consumedContent', 'consumedTimestamp', 'consumedInputId', 'deliveryStarted'];

const PRIVATE_FIELDS = [...CONSUMPTION_FIELDS, 'preparedGoal', 'used'];

function stamp(value: any): string { return JSON.stringify(value ?? null); }

export const GOAL_ENTRY_ID = 'goal';

export type QueueOffer = { steer: number; followUp: number; goal: number; tools: Record<string, boolean> };

export class QueueState {
  pending: any[] = [];
  retained: any[] = [];
  sending = new Set<string>();
  rejected = new Set<string>();
  steerTaken = new Set<string>();
  steeringTimestamps = new Set<string>();
  goals = new QueueGoal();
  held = false;
  stopped = false;
  stopping = false;
  // A worktree setup runs, or its result is not in the transcript yet.
  setup = false;

  queuedGoal() { return this.goals.live(); }

  waiting(): any[] { return this.pending.filter(item => flag(item, 'afterGoal') && !flag(item, 'retry')); }

  markUsed(event: any): void {
    const name = kind(event);
    if ((name !== 'message_start' && name !== 'message_end') || event.message?.role !== 'user' || typeof event.message?.piopQueueId !== 'string') return;
    const item = this.pending.find(entry => entry.id === event.message.piopQueueId);
    if (item) item.used = true;
  }

  hasUnused(): boolean { return this.pending.some(item => !flag(item, 'used')); }

  available(item: any): boolean {
    return !this.held && !this.stopping && !this.setup && !flag(item, 'taken') && !flag(item, 'afterGoal') && !flag(item, 'retry') && !this.sending.has(text(item, 'id'));
  }

  goalAvailable(): boolean { return Boolean(this.goals.live()) && !this.held && !this.stopping && !this.setup && !this.goals.waitingForInput; }

  offer(): QueueOffer {
    const offer = { steer: 0, followUp: 0, goal: this.goalAvailable() ? 1 : 0, tools: { [GOAL_TOOL]: Boolean(this.goals.live()) } };
    for (const item of this.pending) if (this.available(item)) offer[item.behavior === 'steer' ? 'steer' : 'followUp'] += 1;
    return offer;
  }

  durableMessages(): any[] {
    this.retained = durableMessages(this);
    return this.retained;
  }

  remove(id: string): void {
    this.pending = this.pending.filter(item => item.id !== id);
    this.retained = this.retained.filter(item => item.id !== id);
  }

  markRetry(items: any[]): void {
    for (const pending of this.pending) if (items.some(item => item.id === pending.id)) { pending.retry = true; delete pending.taken; }
  }

  order(): void {
    const rank = (item: any) => flag(item, 'retry') ? 3 : flag(item, 'taken') ? 0 : flag(item, 'afterGoal') ? 2 : 1;
    this.pending = this.pending.map((item, index) => [item, index] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([item]) => item);
  }

  view(pending: any[] = this.pending): any {
    const visible = pending.map(original => {
      const item = clone(original);
      for (const field of PRIVATE_FIELDS) delete item[field];
      if (flag(item, 'taken')) item.sending = true;
      delete item.taken;
      if (Array.isArray(item?.images)) for (const image of item.images) if (image && typeof image === 'object' && !Array.isArray(image)) delete image.data;
      return item;
    });
    const goal = this.queuedGoal();
    if (goal) {
      const index = visible.findIndex(item => flag(item, 'afterGoal') || flag(item, 'retry'));
      visible.splice(index < 0 ? visible.length : index, 0, { id: GOAL_ENTRY_ID, message: goal.objective, behavior: 'followUp', goal: true });
    }
    const queued = pending.filter(item => !flag(item, 'retry') && !flag(item, 'afterGoal'));
    return {
      type: 'queue_update',
      steering: queued.filter(item => item.behavior === 'steer').map(item => clone(item.message)),
      followUp: queued.filter(item => item.behavior !== 'steer').map(item => clone(item.message)),
      pendingMessages: visible,
      held: this.held,
    };
  }

  tagMessage(event: any): void {
    const name = kind(event);
    if ((name !== 'message_start' && name !== 'message_end') || event.message?.role !== 'user' || typeof event.message?.timestamp !== 'number') return;
    const timestamp = stamp(event.message.timestamp);
    if (typeof event.message.piopQueueId === 'string' && this.steerTaken.has(event.message.piopQueueId)) this.steeringTimestamps.add(timestamp);
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
