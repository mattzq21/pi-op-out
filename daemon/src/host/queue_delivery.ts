import { CancelScope, clone, kind, text } from './json';
import { errorText } from '../util/sync';
import type { QueueState } from './queue_state';
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

/** Sends commands and queued items to Pi, and publishes the queue after it changes. */
export class QueueDelivery {
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
    this.state.durableMessages();
    const event = this.state.publish();
    await this.record.persist();
    this.executor.publish(event);
  }

  async execute(command: any, scope?: CancelScope): Promise<any> {
    const clearing = kind(command) === 'clear_queue';
    if (!clearing) return this.executor.execute(command);
    this.state.clearing = true;
    const reset = () => { this.state.clearing = false; };
    scope?.add(reset);
    try { return await this.executor.execute(command); } finally { scope?.remove(reset); reset(); }
  }

  async deliver(item: any, discardOnRejection: boolean): Promise<any> {
    const retained = clone(item);
    retained.deliveryStarted = true;
    const id = text(item, 'id');
    this.state.sending.add(id);
    const command: any = { type: 'queue_prompt', queueId: id, message: item.message ?? null, streamingBehavior: item.behavior ?? null, discardOnRejection };
    for (const field of ['goalSubmissionId', 'goalPrepared']) if (item[field] !== undefined) command[field] = clone(item[field]);
    if (Array.isArray(item.images) && item.images.length) command.images = clone(item.images);
    try {
      await this.record.retain(retained);
      const result = await this.execute(command);
      this.state.sending.delete(id);
      if (result?.disposition === 'handled') await this.consumed(id);
      return result;
    } catch (error) {
      this.state.sending.delete(id);
      throw error;
    }
  }

  async consumed(id: string): Promise<void> { await this.reportStorageError(() => this.record.forget(id)); }

  async reportStorageError(operation: () => void | Promise<void>): Promise<void> {
    try { await operation(); } catch (error) {
      console.error(error);
      this.executor.publish({ type: 'extension_error', extensionPath: 'conversation queue', event: 'queue', error: errorText(error) });
    }
  }

}
