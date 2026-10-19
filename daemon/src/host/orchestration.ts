import { randomUUID } from 'node:crypto';
import { flag, text } from './json';
import { ownershipError } from './ownership';
import { isUuid } from './protocol';
import { attach } from './attachment';
import { queueCommand } from './session_commands';
import type { Host } from './controller';
import type { Session } from './session';

const CANCELLED_DELIVERY_TTL_MS = 10 * 60_000;

/**
 * Orchestration requests for conversations on this host: locate, read, send a message, and interrupt.
 * A conversation that is not running is started in a hidden view for the request.
 */
export class Orchestration {
  private deliveries = new Map<string, Set<string>>();
  private cancelledDeliveries = new Map<string, number>();

  constructor(private host: Host) {}

  /** True while a message is being delivered to the conversation. */
  delivering(id: string): boolean { return Boolean(this.deliveries.get(id)?.size); }

  /** True while any message is being delivered. */
  busy(): boolean { return this.deliveries.size > 0; }

  async handle(packet: any): Promise<any> {
    const host = this.host;
    const id = text(packet, 'sessionKey');
    const action = text(packet, 'action');
    if (action === 'locate') return host.ownership().lookup(id);
    if (action === 'interrupt') {
      if (this.cancelDeliveries(id, typeof packet.deliveryId === 'string' ? packet.deliveryId : undefined)) return { sessionId: id, completed: false };
      return this.cancel(id);
    }
    const location = host.ownership().lookup(id);
    if (location.archived === true && action === 'send') throw new Error('This conversation has been deleted or archived');
    const session = host.findSession(id);
    switch (action) {
      case 'read': return session ? session.execute({ type: 'get_snapshot' }) : host.ownership().snapshot(id, packet.sessionPath);
      case 'send': return this.send(packet, session);
      default: throw new Error('Unknown orchestration action');
    }
  }

  private cancelDeliveries(id: string, delivery: string | undefined): boolean {
    const now = Date.now();
    for (const [item, cancelledAt] of this.cancelledDeliveries) if (now - cancelledAt >= CANCELLED_DELIVERY_TTL_MS) this.cancelledDeliveries.delete(item);
    if (delivery !== undefined) this.cancelledDeliveries.set(delivery, now);
    const pending = [...(this.deliveries.get(id) ?? [])];
    for (const item of pending) this.cancelledDeliveries.set(item, now);
    return pending.length > 0;
  }

  private deliveryCancelled(delivery: string): boolean {
    const cancelledAt = this.cancelledDeliveries.get(delivery);
    return cancelledAt !== undefined && Date.now() - cancelledAt < CANCELLED_DELIVERY_TTL_MS;
  }

  private async cancel(id: string): Promise<any> {
    const host = this.host;
    const session = host.findSession(id);
    if (session) return this.interrupt(id, session);
    if (host.ownership().locate(id, null, false, true)) return this.interrupt(id, undefined);
    if (host.ownership().removed(id) || host.ownership().locate(id, null, true, true)) return { sessionId: id, completed: true, retired: true };
    throw new Error('Cannot confirm that this conversation has stopped or been retired');
  }

  private async interrupt(id: string, session: Session | undefined): Promise<any> {
    if (!session) return { sessionId: id, completed: true };
    const release = await session.orchestrationInterrupt.lock();
    try {
      const task = session.orchestrationTask;
      if (task?.finished) {
        session.orchestrationTask = null;
        await task.promise;
        return { sessionId: id, completed: true };
      }
      if (!task) {
        const entry = { finished: false, promise: Promise.resolve() as Promise<any> };
        entry.promise = session.queue.interruptDelegation().finally(() => { entry.finished = true; this.host.maintenance(session.key); });
        entry.promise.catch(() => {});
        session.orchestrationTask = entry;
      }
      return { sessionId: id, completed: false };
    } finally { release(); }
  }

  private reserveDelivery(id: string, delivery: string): void {
    if (!isUuid(delivery)) throw new Error('A valid deliveryId is required');
    if (this.deliveryCancelled(delivery)) throw new Error('Agent delivery was cancelled');
    let set = this.deliveries.get(id);
    if (!set) { set = new Set(); this.deliveries.set(id, set); }
    if (set.has(delivery)) throw new Error('Agent delivery is already pending');
    set.add(delivery);
    this.host.findSession(id)?.idleStop.cancel();
  }

  private releaseDelivery(id: string, delivery: string): void {
    const set = this.deliveries.get(id);
    if (!set) return;
    set.delete(delivery);
    if (!set.size) this.deliveries.delete(id);
    const session = this.host.findSession(id);
    if (session) this.host.maintenance(session.key);
  }

  private async attachHidden(packet: any, runtime: string, id: string): Promise<void> {
    const host = this.host;
    const result = await attach(host, { type: 'attach', runtimeId: runtime, clientId: packet.clientId ?? null, sessionKey: id, spec: packet.spec ?? null, cwd: packet.cwd ?? null, presence: { visible: false } });
    if (!flag(result, 'owned')) {
      host.attachments.delete(runtime);
      host.readonlyMap.delete(runtime);
      throw new Error(ownershipError());
    }
  }

  private async send(packet: any, existing: Session | undefined): Promise<any> {
    const id = text(packet, 'sessionKey');
    const source = text(packet, 'sourceSessionId');
    if (!source || source === id) throw new Error('Choose another conversation as the recipient');
    const message = text(packet, 'message');
    if (!message.trim() || Buffer.byteLength(message) > 100_000) throw new Error('Message must contain 1–100000 bytes');
    const delivery = text(packet, 'deliveryId');
    this.reserveDelivery(id, delivery);
    try {
      const runtime = 'orchestration-' + randomUUID();
      const attached = !existing || existing.stopping();
      if (attached) await this.attachHidden(packet, runtime, id);
      let result: any;
      let failure: unknown;
      try { result = await this.deliver(packet); } catch (error) { failure = error ?? new Error('Delivery failed'); }
      if (attached) {
        try { await this.detach(runtime); } catch (error) { if (failure === undefined) throw error; }
      }
      if (failure !== undefined) throw failure;
      return result;
    } finally { this.releaseDelivery(id, delivery); }
  }

  private async deliver(packet: any): Promise<any> {
    const session = this.host.findSession(text(packet, 'sessionKey'));
    if (!session) throw new Error('Conversation is no longer running');
    if (session.transient() || session.compacting()) throw new Error('Wait for conversation preparation or compaction to finish');
    await session.settings.reconcile(false);
    const error = session.settings.error();
    if (error !== null) throw new Error(error);
    if (this.deliveryCancelled(text(packet, 'deliveryId'))) throw new Error('Agent delivery was cancelled');
    return queueCommand(session, { type: 'orchestration_message', deliveryId: packet.deliveryId ?? null, sourceSessionId: packet.sourceSessionId ?? null,
      sourceHostId: packet.sourceHostId ?? null, message: packet.message ?? null, wake: packet.wake ?? null });
  }

  private async detach(runtime: string): Promise<any> {
    this.host.attachments.delete(runtime);
    const session = this.host.subscriptions.get(runtime);
    return session ? this.host.detach({ preserveRunning: true }, runtime, session) : null;
  }
}
