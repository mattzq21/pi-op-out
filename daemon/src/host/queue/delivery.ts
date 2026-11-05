import { clone, jsonEqual, text } from '../json';
import { errorText } from '../../util/sync';
import type { GoalPlace } from '../goals/files';
import type { QueueOffer, QueueState } from './state';
import type { QueueRecord } from './record';

export interface Execution {
  execute(command: any): Promise<any>;
  publish(event: any): void;
  savedUserMessages?(): any[];
  extensionCommand?(name: string): boolean;
  queueHeld(held: boolean): Promise<void>;
  ask?(dialog: any): Promise<any>;
  goalPlace?(): GoalPlace;
  goalStatus?(event: any): void;
}

export class QueueDelivery {
  private offered: QueueOffer | undefined;
  private offers: Promise<void> = Promise.resolve();
  private sequence = 0;

  constructor(readonly state: QueueState, readonly record: QueueRecord, private executor: Execution) {}

  runsAtOnce(message: string): boolean {
    const name = /^\/(\S+)/.exec(message.trimStart())?.[1];
    return name !== undefined && this.executor.extensionCommand?.(name) === true;
  }

  announce(event: any): void { this.executor.publish(event); }

  async hold(held: boolean): Promise<void> {
    if (this.state.held === held) return;
    this.state.held = held;
    this.offer();
    try {
      await this.record.saveHeld(held);
      await this.executor.queueHeld(held);
    } catch (error) {
      this.state.held = !held;
      await this.reportStorageError(() => this.record.saveHeld(!held));
      await this.reportStorageError(() => this.publish());
      throw error;
    }
    if (!held) this.state.stopped = false;
    await this.publish();
  }

  ask(dialog: any): Promise<any> {
    if (!this.executor.ask) return Promise.reject(new Error('This conversation cannot ask questions'));
    return this.executor.ask(dialog);
  }

  goalPlace(): GoalPlace {
    if (!this.executor.goalPlace) throw new Error('Goals require a saved conversation.');
    return this.executor.goalPlace();
  }

  goalStatus(event: any): void { this.executor.goalStatus?.(event); }

  async publish(): Promise<void> {
    this.state.order();
    this.state.durableMessages();
    const event = this.state.view();
    await this.record.persist();
    this.executor.publish(event);
    this.offer();
  }

  offer(force = false): void {
    const offer = this.state.offer();
    if (!force && this.offered && jsonEqual(this.offered, offer)) return;
    this.offered = offer;
    const sequence = ++this.sequence;
    this.offers = this.offers.then(() => this.executor.execute({ type: 'queue_offer', ...offer, sequence })).then(() => undefined, error => {
      this.offered = undefined;
      this.executor.publish({ type: 'extension_error', extensionPath: 'conversation queue', event: 'queue_offer', error: errorText(error) });
    });
  }

  currentOffer(): QueueOffer & { sequence: number } {
    const offer = this.state.offer();
    this.offered = offer;
    return { ...offer, sequence: ++this.sequence };
  }

  execute(command: any): Promise<any> { return this.executor.execute(command); }

  async deliver(item: any, discardOnRejection: boolean): Promise<any> {
    const id = text(item, 'id');
    this.state.sending.add(id);
    const command: any = { type: 'queue_prompt', queueId: id, message: item.message ?? null, streamingBehavior: item.behavior ?? null, discardOnRejection };
    if (item.goalSubmissionId !== undefined) command.goalSubmissionId = clone(item.goalSubmissionId);
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

export function piImages(item: any): any[] | undefined {
  if (!Array.isArray(item.images) || !item.images.length) return undefined;
  return item.images.map((image: any) => { const { id: _id, ...content } = clone(image); return content; });
}
