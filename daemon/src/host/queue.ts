import { CancelScope, clone, flag, kind, text } from './json';
import { errorText } from '../util/sync';
import { QueueGate } from './queue_gate';
import type { QueueStorage } from './queue_storage';
import { QueueState } from './queue_state';
import { QueueRecord, track } from './queue_record';
import { QueueDelivery, type Execution } from './queue_delivery';
import { changePending, releaseTaken, takeFailed, takeNext } from './queue_changes';
import { enqueue, queuedCommand } from './queue_submission';
import { QueueGoal } from './goals/state';
import { goalArgument, goalCommand, queueTool, runEnded } from './goals/commands';
import { editMessage, type MessageEdit } from './message_edit';

const TIMEOUT = 'Pi command timed out';

export class SessionQueue {
  private s = new QueueState();
  private record: QueueRecord;
  private delivery: QueueDelivery;
  private closed = false;
  private operations = new Set<Promise<unknown>>();
  readonly gate = new QueueGate();
  private stops = 0;

  constructor(executor: Execution, pending: any[] = [], storage: QueueStorage | null = null, held = false, goal = new QueueGoal()) {
    this.s.held = held;
    this.s.goals = goal;
    this.s.retained = clone(pending);
    this.s.pending = clone(pending);
    this.s.order();
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
  saved(): boolean { return this.record.saved(); }

  tagEntries(entries: any): void { this.s.tagEntries(entries); }

  goalStatus(): any { return this.s.goals.status(); }

  liveGoal() { return this.s.goals.live(); }

  observe(event: any): void {
    this.s.markUsed(event);
    if (kind(event) === 'message_end') this.s.goals.added(event.message);
  }

  offer(): void { this.delivery.offer(true); }

  async receive(event: any): Promise<void> {
    const before = this.s.pending.length;
    try { await this.record.observe(event); } catch (error) {
      console.error(error);
      this.record.reportError(errorText(error));
    }
    if (this.s.pending.length !== before) await this.delivery.reportStorageError(() => this.delivery.publish());
    if (kind(event) === 'agent_start' && this.s.goals.waitingForInput) { this.s.goals.waitingForInput = false; this.delivery.offer(); }
    if (kind(event) === 'disconnected') await this.delivery.reportStorageError(() => this.untake());
    if (kind(event) === 'queue_update') return;
    this.s.tagMessage(event);
    this.delivery.announce(event);
  }

  private async untake(): Promise<void> {
    let changed = false;
    for (const item of this.s.pending) if (flag(item, 'taken')) { delete item.taken; delete item.used; item.deliveryStarted = false; changed = true; }
    if (changed) await this.delivery.publish();
  }

  async runtimeEvent(name: string, data: any): Promise<any> {
    if (name === 'queue_outcome') return runEnded(this.delivery, data?.outcome);
    if (name === 'queue_tool') return queueTool(this.delivery, data?.tool, data?.params);
    const release = await this.gate.runtimeLock();
    try {
      if (name === 'queue_take') return await takeNext(this.delivery, data.behavior, data.holding);
      if (name === 'queue_release') return await releaseTaken(this.delivery, data.ids);
      if (name === 'queue_used') {
        if (typeof data?.id !== 'string' || !data.id) throw new Error('queue_used needs the message id');
        await this.delivery.consumed(data.id);
        await this.delivery.publish();
        return null;
      }
      if (name === 'queue_failed') return await takeFailed(this.delivery, data.id, data.error);
      throw new Error('Unknown queue request ' + name);
    } finally { release(); }
  }

  interruptDelegation(): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return track(this.operations, this.abort({ type: 'abort' }, () => {}).then(result => this.stop(result)));
  }

  command(command: any, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return track(this.operations, this.runCommand(command, assertOwner));
  }

  private async runCommand(command: any, assertOwner: () => void): Promise<any> {
    assertOwner();
    const name = kind(command);
    if (name === 'abort') {
      this.s.stopped = true;
      if (this.s.goals.live() || this.s.hasUnused()) await this.delivery.reportStorageError(() => this.delivery.hold(true));
      const result = await this.abort(command, assertOwner);
      assertOwner();
      return this.stop(result);
    }
    if (name === 'compact' || name.startsWith('get_')) return this.delivery.execute(command);
    if (goalArgument(text(command, 'message')) !== undefined) {
      return goalCommand(this.delivery, this.gate, command, assertOwner, item => enqueue(this.delivery, item, 'follow_up'));
    }
    const release = await this.gate.lock();
    try { assertOwner(); return await this.serialCommand(command, name); } finally { release(); }
  }

  private async abort(command: any, assertOwner: () => void): Promise<{ ok: true; value: any } | { ok: false; error: unknown }> {
    const scope = new CancelScope();
    this.stops += 1;
    this.s.stopping = true;
    const operation = (async () => {
      const [cancelled, gate] = await Promise.allSettled([this.delivery.execute({ type: 'abort' }), this.gate.lockLending()]);
      const release = gate.status === 'fulfilled' ? gate.value : undefined;
      if (release) scope.add(release);
      try {
        if (cancelled.status === 'rejected') throw cancelled.reason;
        if (gate.status === 'rejected') throw gate.reason;
        if (scope.cancelled) throw new Error(TIMEOUT);
        assertOwner();
        return await this.delivery.execute(command);
      } finally {
        if (release) { scope.remove(release); release(); }
      }
    })().finally(() => {
      if (--this.stops) return;
      this.s.stopping = false;
      this.delivery.offer();
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { scope.cancel(); reject(new Error(TIMEOUT)); }, 5000); });
    track(this.operations, operation);
    try { return { ok: true, value: await Promise.race([operation, timeout]) }; }
    catch (error) { return { ok: false, error }; }
    finally { clearTimeout(timer); }
  }

  private async serialCommand(command: any, name: string): Promise<any> {
    if (name === 'clear_queue') return this.clear();
    if (name === 'hold_queue') return this.hold(command.held);
    if (name !== 'steer' && name !== 'follow_up') return this.delivery.execute(command);
    return enqueue(this.delivery, command, queuedCommand(text(command, 'message')) ? 'follow_up' : name);
  }

  private async hold(held: unknown): Promise<null> {
    if (typeof held !== 'boolean') throw new Error('hold_queue needs held set to true or false');
    await this.delivery.hold(held);
    return null;
  }

  private async clear(): Promise<any> {
    const removed = this.s.pending.filter(item => !flag(item, 'taken'));
    for (const item of removed) this.s.remove(text(item, 'id'));
    await this.delivery.publish();
    return { steering: removed.filter(item => item.behavior === 'steer').map(item => item.message), followUp: removed.filter(item => item.behavior !== 'steer').map(item => item.message) };
  }

  private async stop(result: { ok: true; value: any } | { ok: false; error: unknown }): Promise<any> {
    if (result.ok) return result.value;
    if (errorText(result.error) === TIMEOUT) return this.forceStop();
    throw result.error;
  }

  private async forceStop(): Promise<any> {
    await this.delivery.execute({ type: 'force_stop' });
    await this.untake();
    this.delivery.announce({ type: 'disconnected' });
    return null;
  }

  editMessage(edit: MessageEdit, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return track(this.operations, editMessage(this.delivery, this.gate, edit, assertOwner));
  }

  changePending(id: string, action: any, assertOwner: () => void = () => {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
    return track(this.operations, changePending(this.delivery, this.gate, id, action, assertOwner));
  }

  confirmConsumed(): Promise<void> { return this.record.confirmConsumed(); }

  async rejected(id: string): Promise<void> {
    this.s.rejected.add(id);
    await this.consumed(id);
  }

  async consumed(id: string): Promise<void> {
    await this.delivery.consumed(id);
    await this.delivery.reportStorageError(() => this.delivery.publish());
  }
}
