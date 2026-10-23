import { array, clone, flag, jsonEqual, kind, messageText, text } from './json';
import { errorText } from '../util/sync';
import type { QueueStorage } from './queue_storage';
import { durableMessages, updateItem, type QueueState } from './queue_state';
import type { Execution } from './queue_delivery';

let nextLocalId = 1;

/** Keeps operation in pending until it settles, and logs its failure. */
export function track<T>(pending: Set<Promise<unknown>>, operation: Promise<T>): Promise<T> {
  pending.add(operation);
  void operation.then(() => { pending.delete(operation); }, error => {
    pending.delete(operation);
    console.error('Queue operation failed: ' + errorText(error));
  });
  return operation;
}

/**
 * Keeps the saved copy of a queue in step with its state, and removes items once Pi's transcript holds them.
 * Without storage, it keeps only the view that clients last received.
 */
export class QueueRecord {
  private saves = new Set<Promise<unknown>>();
  private savedView: any;
  private saveSequence = 0;
  private lastSaveFailed = false;

  constructor(private state: QueueState, private storage: QueueStorage | null, private executor: Execution) {
    this.savedView = state.view(state.pending);
  }

  /** True when items are kept in storage. */
  get durable(): boolean { return this.storage !== null; }

  /** The queue view of the last successful save. */
  view(): any { return clone(this.savedView); }
  setView(view: any): void { this.savedView = view; }

  /** True when storage holds the current queue. Storage is then the only copy, because another host can change it later. */
  saved(): boolean { return this.storage !== null && !this.lastSaveFailed && this.saves.size === 0; }

  async flush(): Promise<void> {
    while (this.saves.size) await Promise.allSettled([...this.saves]);
  }

  nextId(): string {
    if (this.storage) return this.storage.reserveId();
    return String(nextLocalId++);
  }

  async persist(): Promise<void> {
    const retained = durableMessages(this.state);
    const saved = this.saveRetained(retained);
    this.state.retained = retained;
    await this.commitView(saved);
  }

  /** Saves without waiting. Calls saved() after success, and reports a failure to clients. */
  persistInBackground(saved: () => void): void {
    track(this.saves, this.persist().then(() => {
      saved();
    }, error => {
      console.error(error);
      this.reportError(errorText(error));
    }));
  }

  async retain(item: any): Promise<void> {
    const retained = clone(this.state.retained);
    updateItem(retained, item);
    const saved = this.saveRetained(retained);
    this.state.retained = retained;
    await this.commitView(saved);
  }

  async forget(id: string): Promise<void> {
    const retained = this.state.retained.filter(item => item.id !== id);
    const saved = this.saveRetained(retained);
    this.state.retained = retained;
    this.state.pending = this.state.pending.filter(item => item.id !== id);
    if (this.state.held) this.state.held = this.state.held.filter(item => item.id !== id);
    await this.commitView(saved);
  }

  reportError(error: string): void {
    this.executor.publish({ type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: 'Queued input recovery could not be updated: ' + error });
  }

  /** Records which saved item a user message from Pi consumed. */
  async observe(event: any): Promise<void> {
    if (this.storage === null) return;
    if (kind(event) === 'message_end' && event.message?.role === 'user') {
      await this.recordConsumption(event.message);
    }
    if (kind(event) === 'message_end' || kind(event) === 'agent_settled') {
      await this.confirmConsumed();
    }
  }

  /** Removes items that Pi's saved transcript already holds. */
  async confirmConsumed(): Promise<void> {
    if (!this.state.retained.length) return;
    const messages = this.executor.savedUserMessages?.() ?? [];
    const consumed = new Set(this.state.retained.filter(item => messages.some(message => {
      const id = queueMessageId(message);
      return (id !== undefined && item.id === id) || (typeof item.consumedTimestamp === 'number' && matchesRecordedConsumption(item, message));
    })).map(item => text(item, 'id')));
    if (!consumed.size) return;
    const retained = this.state.retained.filter(item => !consumed.has(text(item, 'id')));
    const saved = this.saveRetained(retained);
    this.state.retained = retained;
    this.state.pending = this.state.pending.filter(item => !consumed.has(text(item, 'id')));
    if (this.state.held) this.state.held = this.state.held.filter(item => !consumed.has(text(item, 'id')));
    await this.commitView(saved);
  }

  private async recordConsumption(message: any): Promise<void> {
    if (typeof message?.timestamp !== 'number') return;
    const retained = clone(this.state.retained);
    const candidates = consumptionCandidates(this.state, retained, message);
    if (candidates.length !== 1) return;
    const item = retained[candidates[0]];
    item.consumedTimestamp = clone(message.timestamp);
    item.consumedContent = clone(message.content ?? null);
    item.consumedInputId = queueMessageId(message) ?? null;
    const saved = this.saveRetained(retained);
    this.state.retained = retained;
    await this.commitView(saved);
  }

  private async saveRetained(retained: any[]): Promise<void> {
    if (retained.length > 100) throw new Error('Queue is full');
    if (!this.storage) return;
    const sequence = ++this.saveSequence;
    try {
      await track(this.saves, this.storage.save(retained));
      if (sequence === this.saveSequence) this.lastSaveFailed = false;
    } catch (error) {
      if (sequence === this.saveSequence) this.lastSaveFailed = true;
      throw error;
    }
  }

  private async commitView(saved: Promise<void>): Promise<void> {
    const view = this.state.view(this.state.pending);
    try { await saved; } catch (error) {
      this.reportError(errorText(error));
      throw error;
    }
    this.savedView = view;
  }
}

function queueMessageId(message: any): string | undefined {
  if (typeof message?.piopQueueId === 'string') return message.piopQueueId;
  if (typeof message?.piopQueueInputId === 'string') return message.piopQueueInputId;
  return undefined;
}

function consumptionCandidates(state: QueueState, retained: any[], message: any): number[] {
  const id = queueMessageId(message);
  const indexes = (test: (item: any) => boolean) => retained.map((item, index) => [item, index] as const).filter(([item]) => test(item)).map(([, index]) => index);
  if (id !== undefined) return indexes(item => item.id === id && flag(item, 'deliveryStarted') && (item.consumedTimestamp ?? null) === null);
  if (retained.some(item => jsonEqual(item.consumedTimestamp, message.timestamp))) return [];
  const content = messageText(message.content, '');
  return indexes(item => matchConsumed(item, message, content) && availableForConsumption(state, item));
}

function matchesRecordedConsumption(item: any, message: any): boolean {
  const identified = typeof item.consumedInputId !== 'string' || queueMessageId(message) === item.consumedInputId;
  return identified && jsonEqual(message.timestamp, item.consumedTimestamp) && jsonEqual(message.content, item.consumedContent);
}

function matchConsumed(item: any, message: any, content: string): boolean {
  if (flag(item, 'retry') || !flag(item, 'deliveryStarted') || (item.consumedTimestamp ?? null) !== null || item.message !== content) return false;
  const images = array(item, 'images');
  const actual = array(message, 'content').filter(part => part?.type === 'image');
  return images.length === actual.length && images.every((expected, index) => jsonEqual(expected?.data, actual[index]?.data) && jsonEqual(expected?.mimeType, actual[index]?.mimeType));
}

function availableForConsumption(state: QueueState, item: any): boolean {
  const id = text(item, 'id');
  if (state.heldItems().some(held => held.id === id)) return false;
  return state.sending.has(id) || !state.pending.some(pending => pending.id === id);
}
