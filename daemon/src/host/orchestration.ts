import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { flag, text } from './json';
import { ownershipError } from './ownership';
import { isUuid } from './protocol';
import { attach } from './attachment';
import { queueCommand } from './session_commands';
import * as storageTransactions from '../storage_transactions';
import * as Worktrees from '../chat_worktree_records';
import * as Registry from '../session_registry';
import { detectRepository } from '../chat_worktrees';
import { publishBranchHistory } from '../chat_branch_operations';
import { rememberProjectRepository } from '../project_repositories';
import type { Host } from './controller';
import type { Session } from './session';

const CANCELLED_DELIVERY_TTL_MS = 10 * 60_000;
/** The longest one watch request waits. A reader that waits longer sends another. */
const MAX_WATCH_MS = 5 * 60_000;

/**
 * Orchestration requests for conversations on this host: locate, read, send a message, and interrupt.
 * A conversation that is not running is started in a hidden view for the request.
 */
export class Orchestration {
  private deliveries = new Map<string, Set<string>>();
  /** First messages of new chats that are being delivered, by delivery ID. Each ends with the chat kept or removed. */
  private firstDeliveries = new Map<string, Promise<boolean>>();
  private cancelledDeliveries = new Map<string, number>();
  /** Readers that wait for the next state change of a conversation, by conversation ID. */
  private watchers = new Map<string, Set<() => void>>();

  constructor(private host: Host) {}

  /** True while a message is being delivered to the conversation. */
  delivering(id: string): boolean { return Boolean(this.deliveries.get(id)?.size); }

  /** Wakes the readers that wait for a state change of the conversation id. */
  stateChanged(id: string): void {
    const waiting = this.watchers.get(id);
    if (!waiting) return;
    this.watchers.delete(id);
    for (const wake of waiting) wake();
  }

  /**
   * Returns once the state of the conversation differs from stateKey, the key of the reader's last snapshot (null when
   * it was not running), or after waitMs. changed tells which.
   */
  private watch(id: string, stateKey: string | null, waitMs: number): Promise<{ changed: boolean }> {
    const current = () => this.host.findSession(id)?.stateKey() ?? null;
    if (current() !== stateKey) return Promise.resolve({ changed: true });
    return new Promise(resolve => {
      let waiting = this.watchers.get(id);
      if (!waiting) { waiting = new Set(); this.watchers.set(id, waiting); }
      const wake = () => { clearTimeout(timer); resolve({ changed: true }); };
      const timer = setTimeout(() => { this.watchers.get(id)?.delete(wake); if (!this.watchers.get(id)?.size) this.watchers.delete(id); resolve({ changed: false }); }, Math.min(Math.max(waitMs, 0), MAX_WATCH_MS));
      waiting.add(wake);
    });
  }

  /** True while any message is being delivered. */
  busy(): boolean { return this.deliveries.size > 0; }

  async handle(packet: any): Promise<any> {
    const host = this.host;
    const id = text(packet, 'sessionKey');
    const action = text(packet, 'action');
    if (action === 'locate') return host.ownership().lookup(id);
    if (action === 'watch') return this.watch(id, typeof packet.stateKey === 'string' ? packet.stateKey : null, typeof packet.waitMs === 'number' ? packet.waitMs : 0);
    if (action === 'branch_off') return this.branchOff(id);
    if (action === 'settle_first_message') return this.settleFirstMessage(packet);
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

  /**
   * discardOnFailure marks a new chat: creating it is all or nothing. When the delivery fails, Piop finds out from storage
   * whether the first message arrived: the chat is kept and the send succeeds, or the chat is removed and the send fails.
   */
  private async send(packet: any, existing: Session | undefined): Promise<any> {
    if (!flag(packet, 'discardOnFailure')) return this.sendNow(packet, existing);
    const id = text(packet, 'sessionKey'); const path = text(packet, 'sessionPath'); const delivery = text(packet, 'deliveryId');
    let failure: unknown;
    let result: any;
    const settled = (async () => {
      try { result = await this.sendNow(packet, existing); return await this.keepNewChat(id, packet, false); }
      catch (error) { failure = error; }
      if (await this.firstMessageArrived(id, path, delivery)) return this.keepNewChat(id, packet, true);
      await this.removeNewChat(id, path);
      return false;
    })();
    this.firstDeliveries.set(delivery, settled);
    try {
      if (await settled) return result ?? { sessionId: id, accepted: true, notificationId: delivery };
      throw failure;
    } finally { if (this.firstDeliveries.get(delivery) === settled) this.firstDeliveries.delete(delivery); }
  }

  /**
   * Called when the sender of a first message lost the answer: waits for the delivery to end, then tells whether the chat
   * was kept. A delivery that never reached this host is cancelled, and the chat is removed.
   */
  private async settleFirstMessage(packet: any): Promise<{ arrived: boolean }> {
    const id = text(packet, 'sessionKey'); const path = text(packet, 'sessionPath'); const delivery = text(packet, 'deliveryId');
    if (!isUuid(delivery)) throw new Error('A valid deliveryId is required');
    const pending = this.firstDeliveries.get(delivery);
    if (pending) return { arrived: await pending };
    this.cancelledDeliveries.set(delivery, Date.now());
    if (await this.firstMessageArrived(id, path, delivery)) return { arrived: await this.keepNewChat(id, packet, true) };
    await this.removeNewChat(id, path);
    return { arrived: false };
  }

  /** Reads storage once nothing can write the message any more: Pi stopped, or Pi has the message. */
  private async firstMessageArrived(id: string, path: string, delivery: string): Promise<boolean> {
    if (this.stored(id, path, delivery)) return true;
    const session = this.host.findSession(id);
    if (session && !session.closed()) { await session.stop(); this.host.maintenance(session.key); }
    return this.stored(id, path, delivery);
  }

  /** True when the message waits in the chat's mailbox or is in its transcript. */
  private stored(id: string, path: string, delivery: string): boolean {
    const database = Registry.open(this.host.storageRoot());
    try { if (database.prepare('SELECT 1 FROM session_mailbox WHERE session_id=? AND delivery_id=?').get(id, delivery)) return true; }
    finally { database.close(); }
    if (!path || !existsSync(path)) return false;
    return readFileSync(path, 'utf8').split('\n').some(line => {
      if (!line.includes(delivery)) return false;
      try { const entry = JSON.parse(line); return entry?.customType === 'piop-agent-message' && entry?.details?.notificationId === delivery; }
      catch { return false; }
    });
  }

  /** Keeps a chat whose first message arrived. A stopped one is started again with the launch spec of packet, so it reads the message. */
  private async keepNewChat(id: string, packet: any, restart: boolean): Promise<true> {
    const root = this.host.storageRoot();
    if (Worktrees.read(id, root)?.state === 'preparing') Worktrees.activate(id, root);
    const session = this.host.findSession(id);
    if (restart && (!session || session.closed())) {
      if (!packet.spec) throw new Error('The first message arrived, but the chat could not be started again: no launch spec');
      const runtime = 'orchestration-' + randomUUID();
      await this.attachHidden(packet, runtime, id);
      await this.detach(runtime);
    }
    return true;
  }

  /** Removes a new chat whose first message did not arrive: its transcript, and for a branched-off chat its worktree and branch. */
  private async removeNewChat(id: string, path: string): Promise<void> {
    const session = this.host.findSession(id);
    if (session && !session.closed()) { await session.stop(); this.host.maintenance(session.key); }
    const root = this.host.storageRoot();
    if (Worktrees.read(id, root)) await Worktrees.abandonCreation(id, path, root);
    else await storageTransactions.deleteBlank({ path, id });
  }

  /**
   * Makes a new worktree on a new branch from the last commit of the conversation id, and a new conversation there
   * with its agent and its history through its last finished answer. The worktree stays preparing until the first
   * message arrives; abandonBranch or recovery undoes it otherwise.
   */
  private async branchOff(id: string): Promise<{ sessionId: string; sessionPath: string }> {
    const host = this.host;
    const root = host.storageRoot();
    const session = host.findSession(id);
    if (!session || session.closed()) throw new Error('This conversation is not running');
    const cwd = session.cwd;
    const repository = cwd ? await detectRepository(cwd) : null;
    if (!cwd || !repository) throw new Error('This folder is not a Git repository');
    const state = await session.execute({ type: 'get_state' });
    const sourcePath = typeof state?.sessionFile === 'string' ? state.sessionFile : '';
    if (!sourcePath) throw new Error('The conversation has no session file');
    const snapshot = await session.execute({ type: 'get_snapshot' });
    const entries: any[] = snapshot.history.entries;
    const leafId: string | null = snapshot.history.leafId ?? entries.at(-1)?.id ?? null;
    const entryId = lastFinishedAnswer(entries, leafId);
    if (!entryId) throw new Error('This conversation has no finished answer to branch off from');
    const sessionId = Registry.reserve(root);
    try {
      const created = await Worktrees.create({ sourceCwd: cwd, chatId: sessionId, home: host.home, repository }, root);
      rememberProjectRepository(root, created.worktree, { root: created.worktree, gitDir: created.gitCommonDir });
      const published = await publishBranchHistory({ root, sourcePath, sessionId, cwd: created.worktree, entries, leafId, entryId,
        name: state.sessionName ? state.sessionName + ' (branch)' : undefined });
      return { sessionId, sessionPath: published.sessionPath };
    } catch (error) {
      await Worktrees.abandonCreation(sessionId, null, root);
      throw error;
    }
  }

  private async sendNow(packet: any, existing: Session | undefined): Promise<any> {
    const id = text(packet, 'sessionKey');
    const source = text(packet, 'sourceSessionId');
    if (!source || source === id) throw new Error('Choose another conversation as the recipient');
    const message = text(packet, 'message');
    if (!message.trim()) throw new Error('Message must not be empty');
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
    const delivery = text(packet, 'deliveryId');
    if (this.deliveryCancelled(delivery)) throw new Error('Agent delivery was cancelled');
    return this.queue(session, packet);
  }

  private queue(session: Session, packet: any): Promise<any> {
    return queueCommand(session, { type: 'orchestration_message', deliveryId: packet.deliveryId ?? null, sourceSessionId: packet.sourceSessionId ?? null,
      sourceHostId: packet.sourceHostId ?? null, message: packet.message ?? null, wake: packet.wake ?? null, ...(packet.deliverAs ? { deliverAs: packet.deliverAs } : {}),
      ...(typeof packet.sourceName === 'string' ? { sourceName: packet.sourceName } : {}) });
  }

  private async detach(runtime: string): Promise<any> {
    this.host.attachments.delete(runtime);
    const session = this.host.subscriptions.get(runtime);
    return session ? this.host.detach({ preserveRunning: true }, runtime, session) : null;
  }
}

/** The last finished final answer on the branch that ends at leafId. */
function lastFinishedAnswer(entries: any[], leafId: string | null): string | null {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const seen = new Set<string>();
  for (let id = leafId; id && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
    seen.add(id);
    const message = byId.get(id)?.type === 'message' ? byId.get(id).message : null;
    if (message?.role === 'assistant' && message.stopReason === 'stop' && Array.isArray(message.content) && !message.content.some((part: any) => part?.type === 'toolCall')) return id;
  }
  return null;
}
