import { array, canon, CancelScope, flag, jsonEqual, kind, messageText, text } from './json';
import { Mutex, errorText } from '../util/sync';
import type { QueueStorage } from './queue_storage';

export { clearSaved, QueueStorage } from './queue_storage';

/** The session side that a queue sends commands to and publishes events through. */
export interface Execution {
  execute(command: any): Promise<any>;
  publish(event: any): void;
  savedUserMessages?(): any[];
}

const CONSUMPTION_FIELDS = ['consumedContent', 'consumedTimestamp', 'consumedInputId', 'deliveryStarted'];
const TIMEOUT = 'Pi command timed out';
let nextLocalId = 1;

function clone<T>(value: T): T { return structuredClone(value); }
function key(value: any): string { return canon(value); }
function count(items: any[], value: any): number { return items.filter(item => jsonEqual(item, value)).length; }
function unique(items: any[]): any[] {
  const seen = new Set<string>();
  return items.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
}
function stamp(value: any): string { return JSON.stringify(value ?? null); }

class QueueState {
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

  failedHeld(): any {
    const held = this.held ?? [];
    this.held = null;
    for (const item of held) item.retry = true;
    this.pending = this.pending.filter(item => !held.some(saved => saved.id === item.id));
    this.pending.push(...held);
    return this.publish();
  }

  recoverQuestion(item: any, nextId: () => string): void {
    const request = item.questionResponse?.requestId;
    if (this.retained.some(saved => saved.id === item.id || jsonEqual(saved.questionResponse?.requestId, request))) return;
    const matched = this.retained.find(saved => jsonEqual(saved.message, item.message) && saved.questionResponse === undefined);
    if (matched) {
      const id = text(matched, 'id');
      for (const saved of [...this.pending, ...this.retained, ...this.heldItems()]) {
        if (saved.id === id) { saved.questionResponse = clone(item.questionResponse); saved.recovered = true; }
      }
    } else {
      if (durableMessages(this).length >= 100) throw new Error('Queue is full');
      item = { ...item, id: nextId() };
      this.pending.push(clone(item));
      this.retained.push(clone(item));
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

function queueMessageId(message: any): string | undefined {
  if (typeof message?.piopQueueId === 'string') return message.piopQueueId;
  if (typeof message?.piopQueueInputId === 'string') return message.piopQueueInputId;
  return undefined;
}

function updateItem(items: any[], item: any): void {
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

function sortHeld(held: any[]): void { held.sort((left, right) => Number(left.behavior === 'followUp') - Number(right.behavior === 'followUp')); }

function reviewCommand(message: string): boolean {
  const first = message.split(/\s+/).find(part => part.length > 0);
  return first === '/review' || first === '/rs';
}

function validateHold(state: QueueState): void {
  for (const behavior of ['steer', 'followUp']) {
    for (const message of state.texts(behavior)) {
      const saved = state.pending.filter(item => !flag(item, 'retry') && item.behavior === behavior && jsonEqual(item.message, message)).length;
      if (saved < count(state.texts(behavior), message)) {
        throw new Error('Cannot preserve all queued attachments while pausing. Wait for messages sent outside this window to finish first.');
      }
    }
  }
}

function heldMessages(cleared: any, originals: any[], nextId: () => string): any[] {
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

function goalObjective(message: string): boolean {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('/goal')) return false;
  const rest = trimmed.slice(5);
  if (!/^\s/u.test(rest)) return false;
  const value = rest.trim();
  return value.length > 0 && !['edit', 'clear', 'pause', 'resume', 'budget'].includes(value) && !value.startsWith('budget ');
}

function goalSubmission(command: any): boolean {
  const message = text(command, 'message');
  return goalObjective(message) || (message.trim() === '/goal' && Array.isArray(command.images) && command.images.length > 0);
}

function submissionPayload(command: any, id: string, name: string): any {
  const pending: any = { id, message: command.message ?? null, behavior: name === 'steer' ? 'steer' : 'followUp' };
  for (const field of ['images', 'questionResponse', 'goalSubmissionId', 'goalPrepared']) if (command[field] !== undefined) pending[field] = clone(command[field]);
  return pending;
}

function validAnswer(item: any): boolean {
  const response = item?.questionResponse;
  return typeof item?.message === 'string' && item.behavior === 'followUp' && flag(item, 'retry') && flag(item, 'recovered')
    && response?.type === 'answer_question' && typeof response?.value === 'string'
    && typeof response?.requestId === 'string' && item.id === 'question:' + response.requestId;
}

export class SessionQueue {
  private s = new QueueState();
  private savedView: any;
  private closed = false;
  private saves = new Set<Promise<unknown>>();
  private operations = new Set<Promise<unknown>>();

  private track<T>(pending: Set<Promise<unknown>>, operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.then(() => { pending.delete(operation); }, error => {
      pending.delete(operation);
      console.error('Queue operation failed: ' + errorText(error));
    });
    return operation;
  }

  async flush(): Promise<void> {
    while (this.saves.size) await Promise.allSettled([...this.saves]);
  }

  async drain(): Promise<void> {
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    await this.flush();
  }
  /** Serializes commands that change the queue. */
  readonly gate = new Mutex();

  constructor(private executor: Execution, pending: any[] = [], private storage: QueueStorage | null = null) {
    this.s.retained = clone(pending);
    this.s.pending = clone(pending);
    this.savedView = this.s.view(this.s.pending);
  }

  close(): void { this.closed = true; }

  view(): any { return clone(this.savedView); }
  pending(): any[] { return clone(this.s.durableMessages()); }
  held(): boolean { return this.s.held !== null; }
  heldCount(): number { return this.s.held?.length ?? 0; }
  isEmpty(): boolean { return this.s.pending.length === 0; }

  private async publish(): Promise<void> {
    this.s.durableMessages();
    const event = this.s.publish();
    await this.persistState();
    this.executor.publish(event);
  }

  tagEntries(entries: any): void {
    for (const entry of Array.isArray(entries?.entries) ? entries.entries : []) {
      if (entry?.message?.role === 'user' && this.s.steeringTimestamps.has(stamp(entry.message.timestamp))) entry.message.deliveryBehavior = 'steer';
    }
  }

  async receive(event: any): Promise<void> {
    try { await this.observeConsumption(event); } catch (error) {
      console.error(error);
      this.journalError(errorText(error));
    }
    const state = this.s;
    let queueEvent: any;
    if (kind(event) === 'agent_start') state.inferenceRevision += 1;
    if (kind(event) === 'disconnected') {
      state.pending = clone(state.durableMessages());
      for (const item of state.pending) item.retry = true;
      state.held = null;
      state.steering = [];
      state.followUp = [];
      queueEvent = state.publish();
    } else if (kind(event) === 'queue_update') {
      state.receiveQueue(event);
      await this.persistState();
      if (state.changing) return;
      queueEvent = state.publish();
    }
    if (queueEvent !== undefined) {
      const publish = async () => {
        await this.persistState();
        this.executor.publish(queueEvent);
      };
      if (kind(event) === 'disconnected') await this.reportStorageError(publish);
      else await publish();
    }
    if (kind(event) === 'queue_update') return;
    state.tagMessage(event);
    if (kind(event) === 'agent_settled') state.awaitingSteering = [];
    this.executor.publish(event);
  }

  private async execute(command: any, scope?: CancelScope): Promise<any> {
    const clearing = kind(command) === 'clear_queue';
    if (!clearing) return this.executor.execute(command);
    this.s.clearing = true;
    const reset = () => { this.s.clearing = false; };
    scope?.add(reset);
    try { return await this.executor.execute(command); } finally { scope?.remove(reset); reset(); }
  }

  private async deliver(item: any, discardOnRejection: boolean): Promise<any> {
    const retained = clone(item);
    retained.deliveryStarted = true;
    const id = text(item, 'id');
    this.s.sending.add(id);
    const command: any = { type: 'queue_prompt', queueId: id, message: item.message ?? null, streamingBehavior: item.behavior ?? null, discardOnRejection };
    for (const field of ['goalSubmissionId', 'goalPrepared']) if (item[field] !== undefined) command[field] = clone(item[field]);
    if (item.questionResponse !== undefined) command.questionResponse = clone(item.questionResponse);
    if (Array.isArray(item.images) && item.images.length) command.images = clone(item.images);
    try {
      await this.retainItem(retained);
      const result = await this.execute(command);
      this.s.sending.delete(id);
      if (result?.disposition === 'handled') await this.consumed(id);
      return result;
    } catch (error) {
      this.s.sending.delete(id);
      throw error;
    }
  }

  private async heldFailed(): Promise<void> {
    const event = this.s.failedHeld();
    await this.persistState();
    this.executor.publish(event);
  }

  private async restore(): Promise<void> {
    if (!this.held()) return;
    for (;;) {
      const held = this.s.held;
      const item = held && held.length ? held.shift() : undefined;
      if (!item) break;
      if (flag(item, 'retry')) continue;
      try { await this.deliver(item, false); } catch (error) {
        (this.s.held ??= []).unshift(item);
        await this.heldFailed();
        throw error;
      }
      await this.publish();
    }
    this.s.held = null;
    await this.publish();
  }

  interruptDelegation(): Promise<any> { return this.command({ type: 'abort' }); }

  command(command: any, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return this.track(this.operations, this.runCommand(command, assertOwner));
  }

  private async runCommand(command: any, assertOwner: () => void): Promise<any> {
    assertOwner();
    const name = kind(command);
    if (name === 'abort') {
      const result = await this.abort(command, assertOwner);
      assertOwner();
      return this.stop(result);
    }
    if (name === 'compact' || name.startsWith('get_')) return this.execute(command);
    const release = await this.gate.lock();
    try { assertOwner(); return await this.serialCommand(command, name); } finally { release(); }
  }

  private async abort(command: any, assertOwner: () => void): Promise<{ ok: true; value: any } | { ok: false; error: unknown }> {
    const scope = new CancelScope();
    const operation = (async () => {
      const [cancelled, gate] = await Promise.allSettled([this.execute({ type: 'cancel_preparation' }), this.gate.lock()]);
      const release = gate.status === 'fulfilled' ? gate.value : undefined;
      if (release) scope.add(release);
      try {
        if (cancelled.status === 'rejected') throw cancelled.reason;
        if (gate.status === 'rejected') throw gate.reason;
        if (scope.cancelled) throw new Error(TIMEOUT);
        assertOwner();
        await this.hold(scope);
        if (scope.cancelled) throw new Error(TIMEOUT);
        assertOwner();
        return await this.execute(command, scope);
      } finally {
        if (release) { scope.remove(release); release(); }
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { scope.cancel(); reject(new Error(TIMEOUT)); }, 5000); });
    this.track(this.operations, operation);
    try { return { ok: true, value: await Promise.race([operation, timeout]) }; }
    catch (error) { return { ok: false, error }; }
    finally { clearTimeout(timer); }
  }

  private wakingOrchestration(command: any, name: string): boolean { return name === 'orchestration_message' && command.wake !== false && this.held(); }
  private resumingPrompt(command: any, name: string): boolean { return name === 'resume' || (name === 'prompt' && this.held() && typeof command.message === 'string'); }

  private async serialCommand(command: any, name: string): Promise<any> {
    if (name === 'clear_queue') return this.clear(command);
    if (this.wakingOrchestration(command, name)) return this.resumeCommand(command, name);
    if (name === 'pause') {
      await this.hold();
      try { return await this.execute(command); } catch (error) { await this.heldFailed(); throw error; }
    }
    if (this.resumingPrompt(command, name)) return this.resumeCommand(command, name);
    if (name !== 'steer' && name !== 'follow_up') return this.execute(command);
    return this.enqueue(command, reviewCommand(text(command, 'message')) ? 'follow_up' : name);
  }

  private async clear(command: any): Promise<any> {
    const originals = clone(this.s.pending);
    const result = await this.execute(command);
    const removed = [
      ...originals.filter(item => !flag(item, 'retry') && array(result, item.behavior === 'steer' ? 'steering' : 'followUp').some(message => jsonEqual(message, item.message))),
      ...clone(this.s.heldItems()),
    ];
    for (const item of removed) await this.acknowledgeQuestionRemoval(item, 'remove');
    for (const item of removed) this.s.remove(text(item, 'id'));
    this.s.held = null;
    this.s.steering = []; this.s.followUp = []; this.s.awaitingSteering = [];
    await this.persistState();
    await this.publish();
    return result;
  }

  private async resumeCommand(command: any, name: string): Promise<any> {
    const revision = this.s.inferenceRevision;
    const slash = text(command, 'message').startsWith('/');
    const result = name === 'prompt' && !slash ? await this.executeHeldPrompt(command) : await this.execute(command);
    if (name === 'resume' || name === 'orchestration_message' || !slash || this.s.inferenceRevision !== revision) await this.restore();
    return result;
  }

  private async stop(result: { ok: true; value: any } | { ok: false; error: unknown }): Promise<any> {
    if (result.ok) return result.value;
    if (errorText(result.error) === TIMEOUT) return this.forceStop();
    throw result.error;
  }

  async forceStop(): Promise<any> {
    await this.execute({ type: 'force_stop' });
    const state = this.s;
    state.pending = clone(state.durableMessages());
    for (const item of state.pending) item.retry = true;
    state.held = null;
    state.changing = false; state.clearing = false;
    state.steering = []; state.followUp = []; state.awaitingSteering = [];
    await this.publish();
    this.executor.publish({ type: 'disconnected' });
    return null;
  }

  changePending(id: string, action: any, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return this.track(this.operations, this.runChangePending(id, action, assertOwner));
  }

  private async runChangePending(id: string, action: any, assertOwner: () => void): Promise<any> {
    assertOwner();
    const cancelling = action === 'remove' && this.s.sending.has(id);
    let release: () => void;
    if (cancelling) {
      const [cancelled, gate] = await Promise.allSettled([this.execute({ type: 'cancel_preparation' }), this.gate.lock()]);
      if (cancelled.status === 'rejected') { if (gate.status === 'fulfilled') gate.value(); throw cancelled.reason; }
      if (gate.status === 'rejected') throw gate.reason;
      release = gate.value;
    } else release = await this.gate.lock();
    try {
      assertOwner();
      const change = this.pendingChange(id, action);
      if (!change) return null;
      const { target, behavior, neighbor } = change;
      if (action === 'steer' && reviewCommand(text(target, 'message'))) throw new Error('Review commands can only be queued as a follow-up');
      await this.acknowledgeQuestionRemoval(target, behavior);
      assertOwner();
      if (cancelling) return await this.changeLive(id, 'remove', undefined, action);
      if (this.changeHeld(id, behavior, neighbor, action)) { await this.publish(); return null; }
      if (flag(target, 'retry')) return await this.retry(id, target, behavior);
      return await this.changeLive(id, behavior, neighbor, action);
    } finally { release(); }
  }

  private pendingChange(id: string, action: any): { target: any; behavior: string; neighbor?: string } | undefined {
    const found = this.s.pending.find(item => item.id === id);
    if (!found) return undefined;
    const target = clone(found);
    const behavior = typeof action === 'string' ? action : 'reorder';
    const moving = behavior === 'moveUp' || behavior === 'moveDown' || behavior === 'reorder';
    const neighbor = queueNeighbor(this.s.pending, target, action, behavior);
    if (moving && (flag(target, 'retry') || neighbor === undefined)) return undefined;
    return { target, behavior, neighbor };
  }

  private changeHeld(id: string, behavior: string, neighbor: string | undefined, action: any): boolean {
    const held = this.s.held;
    if (!held || !held.some(item => item.id === id)) return false;
    if (behavior === 'remove') this.s.held = held.filter(item => item.id !== id);
    else if (behavior === 'steer' || behavior === 'followUp') {
      const target = held.find(item => item.id === id);
      if (target) { target.behavior = behavior; target.retry = false; }
    } else if (neighbor !== undefined) moveItem(held, id, neighbor, action);
    sortHeld(this.s.held!);
    if (behavior === 'remove') this.s.remove(id);
    return true;
  }

  private async retry(id: string, target: any, behavior: string): Promise<any> {
    if (behavior === 'remove') {
      this.s.remove(id);
      await this.persistState();
      await this.publish();
      return null;
    }
    target.retry = false;
    target.consumedTimestamp = null;
    target.consumedContent = null;
    target.consumedInputId = null;
    target.behavior = behavior === 'steer' ? 'steer' : 'followUp';
    const index = this.s.pending.findIndex(item => item.id === id);
    if (index >= 0) this.s.pending[index] = clone(target);
    // Mark the item as sending before the save yields, so a queue update that arrives meanwhile keeps it in pending.
    this.s.sending.add(id);
    try { await this.persistState(); } catch (error) { this.s.sending.delete(id); this.markRetry([target]); throw error; }
    let failure: unknown;
    try { await this.deliver(target, false); } catch (error) {
      failure = error;
      const item = this.s.pending.find(entry => entry.id === id);
      if (item) item.retry = true;
    }
    await this.publish();
    if (failure !== undefined) throw failure;
    return null;
  }

  private async changeLive(id: string, behavior: string, neighbor: string | undefined, action: any): Promise<any> {
    const state = this.s;
    const snapshot = [...state.steering, ...state.followUp];
    if (unique(snapshot).length !== snapshot.length || snapshot.some(message => !state.pending.some(item => !flag(item, 'retry') && jsonEqual(item.message, message)))) {
      throw new Error('This queue contains messages that cannot be safely switched. Use Ctrl+Enter to steer a new message.');
    }
    state.changing = true;
    const originals = clone(state.pending);
    try { return await this.replaceLive(id, behavior, neighbor, action, originals); }
    finally { this.s.changing = false; await this.publish(); }
  }

  private async replaceLive(id: string, behavior: string, neighbor: string | undefined, action: any, originals: any[]): Promise<any> {
    const cleared = await this.execute({ type: 'clear_queue' });
    const remaining = clearedMessages(cleared, originals, id, behavior, () => this.nextItemId());
    if (neighbor !== undefined) moveItem(remaining, id, neighbor, action);
    let rest = remaining;
    if (behavior === 'remove') {
      rest = remaining.filter(item => item.id !== id);
      await this.forgetItem(id);
    }
    this.s.pending = [...originals.filter(item => flag(item, 'retry')), ...clone(rest)];
    if (behavior === 'remove') this.s.remove(id);
    try { await this.persistState(); } catch (error) { this.markRetry(rest); throw error; }
    if (rest.some(item => flag(item, 'retry'))) {
      this.markRetry(rest);
      throw new Error('Another source changed the queue while switching. Pending text has been kept for retry; reattach any images from messages sent outside this window.');
    }
    for (let index = 0; index < rest.length; index += 1) {
      try { await this.deliver(rest[index], false); } catch (error) { this.markRetry(rest.slice(index)); throw error; }
    }
    return null;
  }

  private markRetry(items: any[]): void {
    for (const pending of this.s.pending) if (items.some(item => item.id === pending.id)) pending.retry = true;
  }

  /** Pauses delivery: takes Pi's queue back into held items. */
  async hold(scope?: CancelScope): Promise<void> {
    const state = this.s;
    if (state.held !== null) return;
    validateHold(state);
    state.changing = true;
    const originals = clone(state.pending);
    let active = true;
    const surviving = () => originals.filter(item => this.storage === null || this.s.retained.some(retained => retained.id === item.id));
    const recover = () => {
      if (!active) return;
      active = false;
      const restored = surviving().map(clone);
      for (const item of restored) item.retry = true;
      this.s.pending = this.s.pending.filter(item => !restored.some(original => original.id === item.id));
      this.s.pending.push(...restored);
      this.s.changing = false;
      this.s.clearing = false;
      const event = this.s.publish();
      this.track(this.saves, this.persistState().then(() => {
        this.executor.publish(event);
      }, error => {
        console.error(error);
        this.journalError(errorText(error));
      }));
    };
    scope?.add(recover);
    try {
      const cleared = await this.execute({ type: 'clear_queue' }, scope);
      if (!active) throw new Error(TIMEOUT);
      this.s.held = heldMessages(cleared, surviving(), () => this.nextItemId());
      this.s.changing = false;
      active = false;
    } catch (error) {
      recover();
      throw error;
    } finally { scope?.remove(recover); }
    await this.publish();
  }

  async executeHeldPrompt(original: any): Promise<any> {
    if (durableMessages(this.s).length >= 100) throw new Error('Queue is full');
    const command = clone(original);
    const id = this.nextItemId();
    const item: any = { id, message: command.message ?? null, behavior: 'followUp', deliveryStarted: true };
    if (command.images !== undefined) item.images = clone(command.images);
    command.type = 'queue_prompt';
    command.queueId = id;
    command.streamingBehavior = 'followUp';
    command.discardOnRejection = true;
    this.s.pending.push(item);
    this.s.sending.add(id);
    let result: any;
    try { await this.retainItem(item); result = await this.execute(command); } catch (error) {
      this.s.failedSubmission(id);
      this.s.sending.delete(id);
      await this.reportStorageError(() => this.publish());
      throw error;
    } finally { this.s.sending.delete(id); }
    if (result?.disposition === 'handled') await this.consumed(id);
    await this.publish();
    return result;
  }

  private async saveRetained(retained: any[]): Promise<void> {
    if (retained.length > 100) throw new Error('Queue is full');
    if (this.storage) await this.track(this.saves, this.storage.save(retained));
  }

  private async retainItem(item: any): Promise<void> {
    const retained = clone(this.s.retained);
    updateItem(retained, item);
    const saved = this.saveRetained(retained);
    this.s.retained = retained;
    await this.commitView(saved);
  }

  private async forgetItem(id: string): Promise<void> {
    const retained = this.s.retained.filter(item => item.id !== id);
    const saved = this.saveRetained(retained);
    this.s.retained = retained;
    this.s.pending = this.s.pending.filter(item => item.id !== id);
    if (this.s.held) this.s.held = this.s.held.filter(item => item.id !== id);
    await this.commitView(saved);
  }

  private async persistState(): Promise<void> {
    const retained = durableMessages(this.s);
    const saved = this.saveRetained(retained);
    this.s.retained = retained;
    await this.commitView(saved);
  }

  private async commitView(saved: Promise<void>): Promise<void> {
    const view = this.s.view(this.s.pending);
    try { await saved; } catch (error) {
      this.journalError(errorText(error));
      throw error;
    }
    this.savedView = view;
  }

  private journalError(error: string): void {
    this.executor.publish({ type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: 'Queued input recovery could not be updated: ' + error });
  }

  private async observeConsumption(event: any): Promise<void> {
    if (this.storage === null) return;
    if (kind(event) === 'message_end' && event.message?.role === 'user') {
      await this.recordConsumption(event.message);
    }
    if (kind(event) === 'message_end' || kind(event) === 'agent_settled') {
      await this.confirmConsumed();
    }
  }

  private async recordConsumption(message: any): Promise<void> {
    if (typeof message?.timestamp !== 'number') return;
    const retained = clone(this.s.retained);
    const candidates = consumptionCandidates(this.s, retained, message);
    if (candidates.length !== 1) return;
    const item = retained[candidates[0]];
    item.consumedTimestamp = clone(message.timestamp);
    item.consumedContent = clone(message.content ?? null);
    item.consumedInputId = queueMessageId(message) ?? null;
    const saved = this.saveRetained(retained);
    this.s.retained = retained;
    await this.commitView(saved);
  }

  async confirmConsumed(): Promise<void> {
    if (!this.s.retained.length) return;
    const messages = this.executor.savedUserMessages?.() ?? [];
    const consumed = new Set(this.s.retained.filter(item => messages.some(message => {
      const id = queueMessageId(message);
      return (id !== undefined && item.id === id) || (typeof item.consumedTimestamp === 'number' && matchesRecordedConsumption(item, message));
    })).map(item => text(item, 'id')));
    if (!consumed.size) return;
    const retained = this.s.retained.filter(item => !consumed.has(text(item, 'id')));
    const saved = this.saveRetained(retained);
    this.s.retained = retained;
    this.s.pending = this.s.pending.filter(item => !consumed.has(text(item, 'id')));
    if (this.s.held) this.s.held = this.s.held.filter(item => !consumed.has(text(item, 'id')));
    await this.commitView(saved);
  }

  private async reportStorageError(operation: () => void | Promise<void>): Promise<void> {
    try { await operation(); } catch (error) {
      console.error(error);
      this.executor.publish({ type: 'extension_error', extensionPath: 'conversation queue', event: 'queue', error: errorText(error) });
    }
  }

  async rejected(id: string): Promise<void> {
    this.s.rejected.add(id);
    await this.consumed(id);
  }

  async consumed(id: string): Promise<void> { await this.reportStorageError(() => this.forgetItem(id)); }

  questionResponse(request: string): any | undefined {
    const item = this.s.retained.find(entry => entry.questionResponse?.requestId === request);
    return item?.questionResponse === undefined ? undefined : clone(item.questionResponse);
  }

  async recoverQuestionAnswers(answers: any): Promise<void> {
    const added: string[] = [];
    try {
      for (const item of Array.isArray(answers) ? answers : []) if (validAnswer(item)) this.s.recoverQuestion(item, () => {
        const id = this.nextItemId();
        added.push(id);
        return id;
      });
      await this.publish();
    } catch (error) {
      for (const id of added) this.s.remove(id);
      throw error;
    }
  }

  private async acknowledgeQuestionRemoval(item: any, action: string): Promise<void> {
    const response = item?.questionResponse;
    if (action !== 'remove' || response === null || typeof response !== 'object' || Array.isArray(response)) return;
    const command = clone(response);
    command.action = 'resolve';
    command.queueId = item.id ?? null;
    await this.execute(command);
  }

  private async enqueue(command: any, name: string): Promise<any> {
    const request = command.questionResponse?.requestId;
    if (typeof request === 'string' && this.questionResponse(request) !== undefined) return null;
    if (this.s.durableMessages().length >= 100) throw new Error('Queue is full');
    const prepared = await this.prepareSubmission(command);
    if (prepared === undefined) return false;
    const question = prepared.questionResponse?.requestId;
    const id = this.nextItemId();
    const pending = submissionPayload(prepared, id, name);
    if (await this.saveSubmission(id, pending)) {
      await this.reportStorageError(() => this.publish());
      return null;
    }
    let result: any;
    let failure: unknown;
    let failed = false;
    try { result = await this.deliver(pending, typeof question !== 'string'); } catch (error) { failure = error; failed = true; }
    const rejected = failed && this.s.failedSubmission(id);
    this.s.sending.delete(id);
    await this.reportStorageError(() => this.publish());
    if (failed && !rejected) {
      await this.reportStorageError(() => { throw failure; });
      return null;
    }
    if (failed) throw failure;
    return result;
  }

  nextItemId(): string {
    if (this.storage) return this.storage.reserveId();
    return String(nextLocalId++);
  }

  private async prepareSubmission(original: any): Promise<any | undefined> {
    if (!goalSubmission(original)) return original;
    const command = clone(original);
    const request: any = { type: 'prepare_goal_prompt', message: command.message ?? null };
    for (const field of ['images', 'goalSubmissionId']) if (command[field] !== undefined) request[field] = clone(command[field]);
    const prepared = await this.execute(request);
    if (prepared === false) return undefined;
    if (typeof prepared?.message !== 'string') throw new Error('Goal prompt preparation did not produce an objective');
    command.message = prepared.message;
    command.goalSubmissionId = prepared.goalSubmissionId ?? null;
    command.goalPrepared = true;
    delete command.images;
    return command;
  }

  private async saveSubmission(id: string, pending: any): Promise<boolean> {
    if (durableMessages(this.s).length >= 100) throw new Error('Queue is full');
    this.s.pending.push(clone(pending));
    const held = this.s.held !== null;
    if (this.s.held) {
      this.s.held.push(clone(pending));
      sortHeld(this.s.held);
    } else this.s.sending.add(id);
    try { await this.persistState(); } catch (error) {
      this.s.sending.delete(id);
      for (const item of [...this.s.pending, ...this.s.retained, ...this.s.heldItems()]) {
        if (item.id === id) item.retry = true;
      }
      this.savedView = this.s.publish();
      this.executor.publish(clone(this.savedView));
      throw error;
    }
    return held;
  }
}
