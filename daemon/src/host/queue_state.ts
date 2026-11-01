import { clone, flag, kind, text } from './json';
import { GOAL_TOOL, QueueGoal } from './goals/state';

/** Fields that record how Pi took a queued item. Clients do not see them. */
export const CONSUMPTION_FIELDS = ['consumedContent', 'consumedTimestamp', 'consumedInputId', 'deliveryStarted'];

/** Fields that only the queue uses. preparedGoal: the goal that a /goal item sets when Pi takes it. used: Pi started a message with the item. */
const PRIVATE_FIELDS = [...CONSUMPTION_FIELDS, 'preparedGoal', 'used'];

function stamp(value: any): string { return JSON.stringify(value ?? null); }

/** The id of the active goal's entry in the queue view. Queue item ids are numbers, so it does not collide with them. */
export const GOAL_ENTRY_ID = 'goal';

/**
 * What Pi may take now: how many waiting messages of each kind, whether the goal may continue its work (goal is 1),
 * and which tools that the queue answers must stay in the prompt.
 */
export type QueueOffer = { steer: number; followUp: number; goal: number; tools: Record<string, boolean> };

/**
 * The queue of one conversation. The daemon is its only owner and saves it. Pi keeps no queue of its own:
 * when it is ready for a message, it takes the next one (the item is then taken), and the item leaves the queue when Pi's transcript holds it.
 * An item that Pi took but did not use goes back to waiting.
 *
 * The queue also owns the conversation's goal. The goal is an entry of the follow-ups, and its turns are context insertions that Pi takes like messages. Follow-ups below it have afterGoal set; they wait until the goal completes or is cleared,
 * or until the user moves them above the goal. Steering messages never wait for the goal.
 * The hold is the only pause: while the queue is held, Pi takes no item and no goal turn.
 * Pi may take an item that is not taken, not below the goal and not marked for retry, while the queue is not held.
 */
export class QueueState {
  pending: any[] = [];
  retained: any[] = [];
  /** Commands that Pi runs at once, while they are delivered. They never wait in the queue. */
  sending = new Set<string>();
  rejected = new Set<string>();
  /** Ids of taken steering messages, so their user messages show as steering. */
  steerTaken = new Set<string>();
  steeringTimestamps = new Set<string>();
  goals = new QueueGoal();
  /** True while the user holds the queue. */
  held = false;
  /** True after the user stopped a response: the next message the user sends goes first. */
  stopped = false;

  /** The goal while it has a place in the queue. */
  queuedGoal() { return this.goals.live(); }

  /** Follow-ups below the goal entry, in queue order. */
  waiting(): any[] { return this.pending.filter(item => flag(item, 'afterGoal') && !flag(item, 'retry')); }

  /** Marks the item of a user message that Pi started as used. A taken item without it still waits in Pi and comes back when Pi releases it. */
  markUsed(event: any): void {
    const name = kind(event);
    if ((name !== 'message_start' && name !== 'message_end') || event.message?.role !== 'user' || typeof event.message?.piopQueueId !== 'string') return;
    const item = this.pending.find(entry => entry.id === event.message.piopQueueId);
    if (item) item.used = true;
  }

  /** True when an item waits for Pi: not taken, or taken but not used. */
  hasUnused(): boolean { return this.pending.some(item => !flag(item, 'used')); }

  /** True when Pi may take the item now. */
  available(item: any): boolean {
    return !this.held && !flag(item, 'taken') && !flag(item, 'afterGoal') && !flag(item, 'retry') && !this.sending.has(text(item, 'id'));
  }

  /** True when Pi may give the goal its next turn. The goal waits while the queue is held and while the chat waits for the user's first message. */
  goalAvailable(): boolean { return Boolean(this.goals.live()) && !this.held && !this.goals.waitingForInput; }

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

  /** Puts the items in the order the view shows them: taken items, waiting ones, those below the goal, then those marked for retry. Order inside each group stays. */
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

  /** Marks the user message of a taken steering message, so the chat shows it as steering. */
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
