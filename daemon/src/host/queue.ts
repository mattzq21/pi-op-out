import { array, CancelScope, clone, flag, jsonEqual, kind, text } from './json';
import { Mutex, errorText } from '../util/sync';
import type { QueueStorage } from './queue_storage';
import { QueueState, goalStatus, type QueueGoal } from './queue_state';
import { QueueRecord, track } from './queue_record';
import { QueueDelivery, type Execution } from './queue_delivery';
import { changePending } from './queue_changes';
import { enqueue, queuedCommand } from './queue_submission';

const TIMEOUT = 'Pi command timed out';

/** The queued input of one session: routes commands to Pi and keeps a saved copy. */
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
    if (kind(event) === 'agent_start') { state.inferenceRevision += 1; state.running = true; }
    const goal = goalStatus(event);
    if (goal !== undefined) this.goalChanged(goal);
    if (kind(event) === 'disconnected') {
      state.running = false;
      state.pending = clone(state.durableMessages());
      // Pi lost its queue. Follow-ups below the goal were never in it, so they keep waiting.
      for (const item of state.pending) if (!flag(item, 'afterGoal')) item.retry = true;
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
    if (kind(event) === 'agent_settled') {
      state.awaitingSteering = [];
      state.running = false;
      // A run that ends while the goal stays active leaves the goal without turns, so its waiting follow-ups go to Pi.
      if (state.waiting().length) track(this.operations, this.releaseWaiting()).catch(error => this.record.reportError(errorText(error)));
    }
    this.delivery.announce(event);
  }

  /** Shows the goal entry while the goal is active. When the goal stops working, the follow-ups below its entry go to Pi in order. */
  private goalChanged(goal: QueueGoal | null): void {
    const previous = this.s.goal;
    this.s.goal = goal;
    if (previous?.id === goal?.id && previous?.active === goal?.active && previous?.objective === goal?.objective) return;
    track(this.operations, this.releaseWaiting()).catch(error => this.record.reportError(errorText(error)));
  }

  private async releaseWaiting(): Promise<void> {
    const release = await this.gate.lock();
    try {
      const waiting = this.s.goalWorking() ? [] : this.s.waiting();
      for (const item of waiting) item.afterGoal = false;
      await this.record.persist();
      for (let index = 0; index < waiting.length; index += 1) {
        try { await this.delivery.deliver(waiting[index], false); } catch (error) { this.s.markRetry(waiting.slice(index)); throw error; }
      }
      await this.delivery.publish();
    } finally { release(); }
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
        return await this.delivery.execute(command, scope);
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

  private async serialCommand(command: any, name: string): Promise<any> {
    if (name === 'clear_queue') return this.clear(command);
    if (name !== 'steer' && name !== 'follow_up') return this.delivery.execute(command);
    return enqueue(this.delivery, command, queuedCommand(text(command, 'message')) ? 'follow_up' : name);
  }

  private async clear(command: any): Promise<any> {
    const originals = clone(this.s.pending);
    const result = await this.delivery.execute(command);
    const removed = [
      ...originals.filter(item => !flag(item, 'retry') && !flag(item, 'afterGoal') && array(result, item.behavior === 'steer' ? 'steering' : 'followUp').some(message => jsonEqual(message, item.message))),
      ...clone(this.s.waiting()),
    ];
    for (const item of removed) this.s.remove(text(item, 'id'));
    this.s.steering = []; this.s.followUp = []; this.s.awaitingSteering = [];
    await this.record.persist();
    await this.delivery.publish();
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
    for (const item of state.pending) if (!flag(item, 'afterGoal')) item.retry = true;
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

  /** Removes items that Pi's saved transcript already holds. */
  confirmConsumed(): Promise<void> { return this.record.confirmConsumed(); }

  async rejected(id: string): Promise<void> {
    this.s.rejected.add(id);
    await this.consumed(id);
  }

  async consumed(id: string): Promise<void> { await this.delivery.consumed(id); }

}
