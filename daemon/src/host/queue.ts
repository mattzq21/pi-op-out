import { array, CancelScope, clone, flag, jsonEqual, kind, text } from './json';
import { Mutex, errorText } from '../util/sync';
import type { QueueStorage } from './queue_storage';
import { QueueState, heldMessages } from './queue_state';
import { QueueRecord, track } from './queue_record';
import { QueueDelivery, type Execution } from './queue_delivery';
import { changePending } from './queue_changes';
import { enqueue, executeHeldPrompt, queuedCommand } from './queue_submission';

const TIMEOUT = 'Pi command timed out';

/** The queued input of one session: routes commands to Pi, pauses and resumes delivery, and keeps a saved copy. */
export class SessionQueue {
  private s = new QueueState();
  private record: QueueRecord;
  private delivery: QueueDelivery;
  private closed = false;
  private operations = new Set<Promise<unknown>>();
  /** Serializes commands that change the queue. */
  readonly gate = new Mutex();

  constructor(executor: Execution, pending: any[] = [], storage: QueueStorage | null = null) {
    this.s.retained = clone(pending);
    this.s.pending = clone(pending);
    this.record = new QueueRecord(this.s, storage, executor);
    this.delivery = new QueueDelivery(this.s, this.record, executor);
  }

  async flush(): Promise<void> { await this.record.flush(); }

  async drain(): Promise<void> {
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    await this.flush();
  }

  close(): void { this.closed = true; }

  view(): any { return this.record.view(); }
  pending(): any[] { return clone(this.s.durableMessages()); }
  held(): boolean { return this.s.held !== null; }
  heldCount(): number { return this.s.held?.length ?? 0; }
  isEmpty(): boolean { return this.s.pending.length === 0; }
  /** True when storage holds the current queue. Storage is then the only copy, because another host can change it later. */
  saved(): boolean { return this.record.saved(); }

  tagEntries(entries: any): void { this.s.tagEntries(entries); }

  async receive(event: any): Promise<void> {
    try { await this.record.observe(event); } catch (error) {
      console.error(error);
      this.record.reportError(errorText(error));
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
      await this.record.persist();
      if (state.changing) return;
      queueEvent = state.publish();
    }
    if (queueEvent !== undefined) {
      const publish = async () => {
        await this.record.persist();
        this.delivery.announce(queueEvent);
      };
      if (kind(event) === 'disconnected') await this.delivery.reportStorageError(publish);
      else await publish();
    }
    if (kind(event) === 'queue_update') return;
    state.tagMessage(event);
    if (kind(event) === 'agent_settled') state.awaitingSteering = [];
    this.delivery.announce(event);
  }

  private async restore(): Promise<void> {
    if (!this.held()) return;
    for (;;) {
      const held = this.s.held;
      const item = held && held.length ? held.shift() : undefined;
      if (!item) break;
      if (flag(item, 'retry')) continue;
      try { await this.delivery.deliver(item, false); } catch (error) {
        (this.s.held ??= []).unshift(item);
        await this.delivery.heldFailed();
        throw error;
      }
      await this.delivery.publish();
    }
    this.s.held = null;
    await this.delivery.publish();
  }

  interruptDelegation(): Promise<any> { return this.command({ type: 'abort' }); }

  command(command: any, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return track(this.operations, this.runCommand(command, assertOwner));
  }

  private async runCommand(command: any, assertOwner: () => void): Promise<any> {
    assertOwner();
    const name = kind(command);
    if (name === 'abort') {
      const result = await this.abort(command, assertOwner);
      assertOwner();
      return this.stop(result);
    }
    if (name === 'compact' || name.startsWith('get_')) return this.delivery.execute(command);
    const release = await this.gate.lock();
    try { assertOwner(); return await this.serialCommand(command, name); } finally { release(); }
  }

  private async abort(command: any, assertOwner: () => void): Promise<{ ok: true; value: any } | { ok: false; error: unknown }> {
    const scope = new CancelScope();
    const operation = (async () => {
      // The first stop cancels preparation and the running response together, so a wait it ends cannot start another model call.
      const [cancelled, gate] = await Promise.allSettled([this.delivery.execute({ type: 'abort' }), this.gate.lock()]);
      const release = gate.status === 'fulfilled' ? gate.value : undefined;
      if (release) scope.add(release);
      try {
        if (cancelled.status === 'rejected') throw cancelled.reason;
        if (gate.status === 'rejected') throw gate.reason;
        if (scope.cancelled) throw new Error(TIMEOUT);
        assertOwner();
        const result = await this.delivery.execute(command, scope);
        // Stop ends a pause. Messages the pause held are not sent by themselves; they wait for the user to send them again.
        if (this.held()) await this.delivery.heldFailed();
        return result;
      } finally {
        if (release) { scope.remove(release); release(); }
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { scope.cancel(); reject(new Error(TIMEOUT)); }, 5000); });
    track(this.operations, operation);
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
      try { return await this.delivery.execute(command); } catch (error) { await this.delivery.heldFailed(); throw error; }
    }
    if (this.resumingPrompt(command, name)) return this.resumeCommand(command, name);
    if (name !== 'steer' && name !== 'follow_up') return this.delivery.execute(command);
    return enqueue(this.delivery, command, queuedCommand(text(command, 'message')) ? 'follow_up' : name);
  }

  private async clear(command: any): Promise<any> {
    const originals = clone(this.s.pending);
    const result = await this.delivery.execute(command);
    const removed = [
      ...originals.filter(item => !flag(item, 'retry') && array(result, item.behavior === 'steer' ? 'steering' : 'followUp').some(message => jsonEqual(message, item.message))),
      ...clone(this.s.heldItems()),
    ];
    for (const item of removed) this.s.remove(text(item, 'id'));
    this.s.held = null;
    this.s.steering = []; this.s.followUp = []; this.s.awaitingSteering = [];
    await this.record.persist();
    await this.delivery.publish();
    return result;
  }

  private async resumeCommand(command: any, name: string): Promise<any> {
    const revision = this.s.inferenceRevision;
    const slash = text(command, 'message').startsWith('/');
    const result = name === 'prompt' && !slash ? await executeHeldPrompt(this.delivery, command) : await this.delivery.execute(command);
    if (name === 'resume' || name === 'orchestration_message' || !slash || this.s.inferenceRevision !== revision) await this.restore();
    return result;
  }

  private async stop(result: { ok: true; value: any } | { ok: false; error: unknown }): Promise<any> {
    if (result.ok) return result.value;
    if (errorText(result.error) === TIMEOUT) return this.forceStop();
    throw result.error;
  }

  private async forceStop(): Promise<any> {
    await this.delivery.execute({ type: 'force_stop' });
    const state = this.s;
    state.pending = clone(state.durableMessages());
    for (const item of state.pending) item.retry = true;
    state.held = null;
    state.changing = false; state.clearing = false;
    state.steering = []; state.followUp = []; state.awaitingSteering = [];
    await this.delivery.publish();
    this.delivery.announce({ type: 'disconnected' });
    return null;
  }

  changePending(id: string, action: any, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return track(this.operations, changePending(this.delivery, this.gate, id, action, assertOwner));
  }

  /** Pauses delivery: takes Pi's queue back into held items. */
  private async hold(scope?: CancelScope): Promise<void> {
    const state = this.s;
    if (state.held !== null) return;
    state.assertHoldable();
    state.changing = true;
    const originals = clone(state.pending);
    let active = true;
    const surviving = () => originals.filter(item => !this.record.durable || this.s.retained.some(retained => retained.id === item.id));
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
      this.record.persistInBackground(() => this.delivery.announce(event));
    };
    scope?.add(recover);
    try {
      const cleared = await this.delivery.execute({ type: 'clear_queue' }, scope);
      if (!active) throw new Error(TIMEOUT);
      this.s.held = heldMessages(cleared, surviving(), () => this.record.nextId());
      this.s.changing = false;
      active = false;
    } catch (error) {
      recover();
      throw error;
    } finally { scope?.remove(recover); }
    await this.delivery.publish();
  }

  /** Removes items that Pi's saved transcript already holds. */
  confirmConsumed(): Promise<void> { return this.record.confirmConsumed(); }

  async rejected(id: string): Promise<void> {
    this.s.rejected.add(id);
    await this.consumed(id);
  }

  async consumed(id: string): Promise<void> { await this.delivery.consumed(id); }

}
