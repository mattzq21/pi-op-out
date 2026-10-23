import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
    if (action === 'branch_off') return this.branchOff(id);
    if (action === 'abandon_branch') return this.abandonBranch(id, text(packet, 'sessionPath'));
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
   * discardOnFailure marks a new chat: when its first message cannot be delivered, the chat is stopped and deleted, so creating it is all or nothing.
   * deleteBlank keeps a transcript that holds a message or queued input, so a message that did arrive is never lost.
   */
  private async send(packet: any, existing: Session | undefined): Promise<any> {
    const discard = flag(packet, 'discardOnFailure');
    const id = text(packet, 'sessionKey');
    try {
      const result = await this.sendNow(packet, existing, discard);
      // A branched-off peer keeps its worktree once its first message arrived.
      if (discard && Worktrees.read(id, this.host.storageRoot())?.state === 'preparing') Worktrees.activate(id, this.host.storageRoot());
      return result;
    } catch (error) {
      const session = this.host.findSession(id);
      if (discard && (!session || session.closed())) await storageTransactions.deleteBlank({ path: text(packet, 'sessionPath'), id });
      throw error;
    }
  }

  /**
   * Makes a new worktree on a new branch from the current files of the conversation id, and a new conversation there
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

  /** Undoes a branch-off whose first message did not arrive. One that did arrive, or still runs, is kept. Returns whether it was kept. */
  private async abandonBranch(id: string, sessionPath: string): Promise<{ kept: boolean }> {
    const root = this.host.storageRoot();
    const record = Worktrees.read(id, root);
    if (record?.state !== 'preparing') return { kept: record !== null };
    const session = this.host.findSession(id);
    const arrived = Boolean(session && !session.closed()) || existsSync(sessionPath.replace(/\.jsonl$/, '.snapshots/mailbox'));
    if (arrived) { Worktrees.activate(id, root); return { kept: true }; }
    await Worktrees.abandonCreation(id, sessionPath, root);
    return { kept: false };
  }

  private async sendNow(packet: any, existing: Session | undefined, discard: boolean): Promise<any> {
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
        try { await this.detach(runtime, discard && failure !== undefined); } catch (error) { if (failure === undefined) throw error; }
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
      sourceHostId: packet.sourceHostId ?? null, message: packet.message ?? null, wake: packet.wake ?? null, ...(packet.deliverAs ? { deliverAs: packet.deliverAs } : {}),
      ...(typeof packet.sourceName === 'string' ? { sourceName: packet.sourceName } : {}) });
  }

  private async detach(runtime: string, discardBlank = false): Promise<any> {
    this.host.attachments.delete(runtime);
    const session = this.host.subscriptions.get(runtime);
    return session ? this.host.detach(discardBlank ? { discardBlank: true } : { preserveRunning: true }, runtime, session) : null;
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
