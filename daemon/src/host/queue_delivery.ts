import { clone, text } from './json';
import { errorText } from '../util/sync';
import type { QueueOffer, QueueState } from './queue_state';
import type { QueueRecord } from './queue_record';

/** The session side that a queue sends commands to and publishes events through. */
export interface Execution {
  execute(command: any): Promise<any>;
  publish(event: any): void;
  savedUserMessages?(): any[];
  /** True when name is an extension command that Pi runs at once instead of sending it to the model. */
  extensionCommand?(name: string): boolean;
  /** Tells Pi whether the queue is on hold, so extensions do not send queued work on their own while it is. */
  queueHeld(held: boolean): Promise<void>;
}

/** Saves the queue, publishes it to clients, and tells Pi how many messages it may take. Delivers the commands that Pi runs at once. */
export class QueueDelivery {
  /** The offer Pi has, so an unchanged queue sends nothing. Pi asks for messages by itself; the offer tells it when to ask. */
  private offered: QueueOffer | undefined;
  private offers: Promise<void> = Promise.resolve();
  /** Numbers the offers, so Pi keeps the newest one when an offer and an answer to a take cross. */
  private sequence = 0;

  constructor(readonly state: QueueState, readonly record: QueueRecord, private executor: Execution) {}

  /** True when the message starts with an extension command, which Pi runs at once. */
  runsAtOnce(message: string): boolean {
    const name = /^\/(\S+)/.exec(message.trimStart())?.[1];
    return name !== undefined && this.executor.extensionCommand?.(name) === true;
  }

  /** Sends an event to the session without changing the queue. */
  announce(event: any): void { this.executor.publish(event); }

  /** Tells Pi whether the queue is on hold. */
  tellHeld(held: boolean): Promise<void> { return this.executor.queueHeld(held); }

  async publish(): Promise<void> {
    this.state.order();
    this.state.durableMessages();
    const event = this.state.view();
    await this.record.persist();
    this.executor.publish(event);
    this.offer();
  }

  /** Tells Pi how many messages it may take. force sends it again, for a Pi that just started. */
  offer(force = false): void {
    const offer = this.state.offer();
    if (!force && this.offered && this.offered.steer === offer.steer && this.offered.followUp === offer.followUp) return;
    this.offered = offer;
    const sequence = ++this.sequence;
    this.offers = this.offers.then(() => this.executor.execute({ type: 'queue_offer', ...offer, sequence })).then(() => undefined, error => {
      this.offered = undefined;
      this.executor.publish({ type: 'extension_error', extensionPath: 'conversation queue', event: 'queue_offer', error: errorText(error) });
    });
  }

  /** The offer as it is now, for the answer to a take. */
  currentOffer(): QueueOffer & { sequence: number } {
    const offer = this.state.offer();
    this.offered = offer;
    return { ...offer, sequence: ++this.sequence };
  }

  execute(command: any): Promise<any> { return this.executor.execute(command); }

  /** Sends a command that Pi runs at once. It never waits in the queue; its saved copy goes when Pi handled it. */
  async deliver(item: any, discardOnRejection: boolean): Promise<any> {
    const id = text(item, 'id');
    this.state.sending.add(id);
    const command: any = { type: 'queue_prompt', queueId: id, message: item.message ?? null, streamingBehavior: item.behavior ?? null, discardOnRejection };
    for (const field of ['goalSubmissionId', 'goalPrepared']) if (item[field] !== undefined) command[field] = clone(item[field]);
    const images = piImages(item);
    if (images) command.images = images;
    try {
      await this.record.retain({ ...clone(item), deliveryStarted: true });
      const result = await this.execute(command);
      if (result?.disposition === 'handled') await this.consumed(id);
      return result;
    } finally { this.state.sending.delete(id); }
  }

  async consumed(id: string): Promise<void> { await this.reportStorageError(() => this.record.forget(id)); }

  async reportStorageError(operation: () => void | Promise<void>): Promise<void> {
    try { await operation(); } catch (error) {
      console.error(error);
      this.executor.publish({ type: 'extension_error', extensionPath: 'conversation queue', event: 'queue', error: errorText(error) });
    }
  }
}

/** The images of an item as Pi gets them: without the ids that tell them apart in the queue view. */
export function piImages(item: any): any[] | undefined {
  if (!Array.isArray(item.images) || !item.images.length) return undefined;
  return item.images.map((image: any) => { const { id: _id, ...content } = clone(image); return content; });
}
