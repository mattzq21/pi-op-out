import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import * as Registry from '../session_registry';
import * as Settings from '../settings';
import * as Extensions from '../extensions';
import * as DaemonRestart from '../daemon_restart';
import { nodeCommand } from '../node_command';
import { storageTransactionBundle } from '../resources';
import { Mutex, errorText, sleep } from '../util/sync';
import { flag, kind, text, jsonEqual } from './json';
import * as Agents from './agents';
import { ConversationOwnership, Guard, ownershipError } from './ownership';
import { clientPayload, savedToolPayload } from './payload';
import { argument, expandHome, parseLaunchSpec, serializeSpec, sessionSpec, specIdentity, type LaunchSpec, type SessionLaunch } from './protocol';
import { clearSaved } from './queue';
import { recoverMissingTranscripts, type Recovery } from './queue_recovery';
import { Session, type SessionHost } from './session';
import { ToolPayload, ToolPayloadCache } from './tool_payload';
import * as Branching from './branching';
import type { HostServices } from './services';

export interface ReadonlyView { id: string; path: string | null }

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
function isUuid(value: string): boolean { return UUID.test(value.replace(/^urn:uuid:/, '').replace(/^\{(.*)\}$/, '$1')); }

function gate(map: Map<string, Mutex>, key: string): Mutex {
  let found = map.get(key);
  if (!found) { found = new Mutex(); map.set(key, found); }
  return found;
}

export class Host implements SessionHost {
  sessions = new Map<string, Session>();
  subscriptions = new Map<string, Session>();
  attachments = new Map<string, any>();
  readonlyMap = new Map<string, ReadonlyView>();
  pending = new Map<string, any[]>();
  configurationValue: any | null = null;
  agentDefinitions: any = null;
  agentRevision = 0;
  requestedAgentRevision = 0;
  guards = new Map<string, [Guard, string]>();
  maintenanceSet = new Set<string>();
  releaseGates = new Map<string, Mutex>();
  dialogGates = new Map<string, Mutex>();
  sessionGates = new Map<string, Mutex>();
  deliveries = new Map<string, Set<string>>();
  cancelledDeliveries = new Set<string>();
  private configurationGate = new Mutex();
  private ownershipValue: ConversationOwnership | undefined;
  readonly toolPayloads = new ToolPayloadCache();
  private timers: NodeJS.Timeout[] = [];

  private constructor(readonly home: string, readonly storage: string, readonly services: HostServices, private sink: (packet: any) => void) {}

  static async create(home: string, storage: string, services: HostServices, sink: (packet: any) => void): Promise<Host> {
    const settings = Settings.readSettingsAt(join(home, storage, 'settings.json'));
    const definitions = await Agents.load(home, storage, Extensions.runtimeSettings(settings), true);
    const host = new Host(home, storage, services, sink);
    host.agentDefinitions = definitions;
    host.ownershipValue = await ConversationOwnership.create(home, storage, { revoke: (id, intent) => host.releaseConversation(id, intent) });
    host.recoverQueuedInput();
    services.bind(host);
    await services.initialize();
    host.watchRemovals();
    host.watchRetention();
    return host;
  }

  storageRoot(): string { return join(this.home, this.storage); }
  ownership(): ConversationOwnership { return this.ownershipValue!; }
  output(packet: any): void { this.sink(clientPayload(packet)); }

  // Session callbacks.
  queueRoot(): string | null { return join(this.home, this.storage, 'queued-input'); }
  configuration(): any | null { return this.configurationValue === null ? null : structuredClone(this.configurationValue); }
  readonlyViews(identity: string): string[] { return [...this.readonlyMap].filter(([, view]) => view.id === identity).map(([id]) => id); }
  readonly(runtime: string): boolean { return this.readonlyMap.has(runtime); }
  rekey(old: string, next: string, epoch: string): void {
    const session = this.sessions.get(old);
    if (session && session.epoch === epoch) { this.sessions.delete(old); this.sessions.set(next, session); }
  }
  finished(key: string, epoch: string, pending: any[], transient: boolean): void {
    if (!transient && this.sessions.get(key)?.epoch === epoch) this.sessions.delete(key);
    if (pending.length) this.pending.set(key, pending);
    for (const [runtime, session] of [...this.subscriptions]) if (session.epoch === epoch) this.subscriptions.delete(runtime);
  }
  maintenance(key: string): void { this.maintain(key); }
  refreshProviders(): Promise<number> { return this.services.refreshProviders(); }

  private watchRemovals(): void {
    const timer = setInterval(() => {
      const targets = new Map<string, string | null>();
      for (const view of this.readonlyMap.values()) targets.set(view.id, view.path);
      for (const [id, path] of targets) {
        let removed = false;
        try { removed = this.ownership().removed(id); } catch {}
        if (removed) this.output({ type: 'session_removed', sessionId: id, sessionPath: path });
      }
    }, 2000);
    timer.unref();
    this.timers.push(timer);
  }

  findSession(identity: string): Session | undefined {
    for (const session of this.sessions.values()) if (session.identity === identity && !session.closed()) return session;
    return undefined;
  }

  current(runtime: string, session: Session): boolean { return this.subscriptions.get(runtime)?.epoch === session.epoch; }

  spawnSession(launch: SessionLaunch): Session {
    const key = launch.key;
    const pending = this.pending.get(key) ?? [];
    this.pending.delete(key);
    let session: Session;
    try { session = Session.spawn(launch, structuredClone(pending), this, this.home, this.toolPayloads); }
    catch (error) { if (pending.length) this.pending.set(key, pending); throw error; }
    this.sessions.set(key, session);
    if (session.closed()) this.forgetWorker(session);
    return session;
  }

  remember(runtime: string, session: Session): void {
    const saved = session.savedState();
    const spec = sessionSpec(session.spec, '--session-id', typeof saved?.sessionId === 'string' ? saved.sessionId : session.identity);
    const packet = structuredClone(this.attachments.get(runtime) ?? {});
    packet.spec = serializeSpec(spec);
    packet.sessionKey = session.identity;
    packet.cwd = session.cwd;
    this.attachments.set(runtime, packet);
  }

  attachView(runtime: string, session: Session, presence: any): void {
    this.subscriptions.set(runtime, session);
    session.attach(runtime, presence);
  }

  forgetWorker(session: Session): void {
    const key = session.key;
    if (this.sessions.get(key)?.epoch === session.epoch) this.sessions.delete(key);
  }

  private maintain(key: string): void {
    const session = this.sessions.get(key);
    if (!session || this.maintenanceSet.has(session.epoch)) return;
    this.maintenanceSet.add(session.epoch);
    void (async () => {
      await session.reconcile(false);
      try { await this.releaseUnused(session); } catch (error) {
        this.output({ type: 'diagnostic', line: 'Could not release unused ownership for ' + session.key + ': ' + errorText(error) });
      }
      this.maintenanceSet.delete(session.epoch);
    })();
  }

  async releaseUnused(session: Session): Promise<void> {
    if (session.unused()) await this.ownership().releaseClient(session.identity, session.clientId(), () => session.unused());
  }

  reconcile(session: Session): void {
    void (async () => {
      await session.reconcile(true);
      try { await this.releaseUnused(session); } catch {}
    })();
  }

  async releaseConversation(id: string, intent: string): Promise<void> {
    const release = await gate(this.releaseGates, id).lock();
    try {
      const sessions = [...this.sessions.values()].filter(session => session.identity === id);
      for (const session of sessions) await this.releaseOwnedSession(id, intent, session);
    } finally { release(); }
  }

  async releaseOwnedSession(id: string, intent: string, session: Session): Promise<void> {
    if (intent === 'transfer' && (session.working() || session.compacting())) {
      throw new Error('The agent is running on another daemon. Wait for it to finish before transferring ownership.');
    }
    if (intent === 'message') await session.retire();
    const saved = session.savedState();
    for (const [runtime] of session.views()) this.readonlyMap.set(runtime, { id, path: typeof saved?.sessionFile === 'string' ? saved.sessionFile : null });
    session.publish({ type: 'ownership_lost' }, null);
    if (intent === 'transfer-local') return;
    if (intent !== 'archive' && (session.working() || session.compacting())) { try { await session.raw({ type: 'abort' }); } catch {} }
    await session.stop();
    if (intent === 'archive') this.pending.delete(session.key);
  }

  private async configure(configuration: any): Promise<void> {
    const revision = configuration?.agentRevision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision > 9007199254740991
      || !configuration.settings || typeof configuration.settings !== 'object' || Array.isArray(configuration.settings)
      || typeof configuration.autoCompaction !== 'boolean' || typeof configuration.autoRetry !== 'boolean') {
      throw new Error('Invalid daemon configuration');
    }
    const release = await this.configurationGate.lock();
    let sessions: Session[];
    try {
      const changed = revision !== this.requestedAgentRevision;
      const definitions = changed ? await Agents.load(this.home, this.storage, configuration.settings, false) : undefined;
      if (definitions !== undefined) { this.agentDefinitions = definitions; this.agentRevision += 1; }
      this.requestedAgentRevision = revision;
      const next = structuredClone(configuration);
      next.agentRevision = this.agentRevision;
      this.configurationValue = next;
      sessions = [...this.sessions.values()];
    } finally { release(); }
    for (const session of sessions) {
      session.publish({ type: 'settings_pending', pending: session.settingsPending() }, null);
      this.reconcile(session);
    }
  }

  private async reloadAgents(runtime: string, sessionId: string): Promise<any> {
    const release = await this.configurationGate.lock();
    let revision: number;
    let sessions: Session[];
    try {
      const target = this.agentReloadTarget(runtime, sessionId);
      if (this.configurationValue === null) throw new Error('Daemon is not configured');
      const settings = structuredClone(this.configurationValue.settings ?? null);
      const definitions = await Agents.load(this.home, this.storage, settings, false);
      if (target !== this.agentReloadTarget(runtime, sessionId)) throw new Error('The session changed while loading agent definitions. Reload from its current host.');
      this.agentRevision += 1;
      revision = this.agentRevision;
      this.agentDefinitions = definitions;
      if (this.configurationValue) this.configurationValue.agentRevision = revision;
      sessions = [...this.sessions.values()];
    } finally { release(); }
    for (const session of sessions) {
      session.publish({ type: 'settings_pending', pending: true }, null);
      this.reconcile(session);
    }
    return { success: true, sessionId, agentRevision: revision };
  }

  private agentReloadTarget(runtime: string, sessionId: string): Session {
    if (this.readonlyMap.has(runtime)) throw new Error(ownershipError());
    const session = this.subscriptions.get(runtime);
    if (!session || session.identity !== sessionId || session.closed()) throw new Error('The session changed. Reload agent definitions from its current host.');
    return session;
  }

  private async detachReadonly(runtime: string, target: ReadonlyView): Promise<any> {
    this.readonlyMap.delete(runtime);
    this.attachments.delete(runtime);
    const session = this.subscriptions.get(runtime) ?? this.findSession(target.id);
    this.subscriptions.delete(runtime);
    if (session) {
      session.detachView(runtime);
      await session.finishDetach(false, true);
      await this.releaseUnused(session);
    }
    return { stopped: false };
  }

  private async readonlyCommand(packet: any, target: ReadonlyView): Promise<any> {
    const runtime = text(packet, 'runtimeId');
    if (kind(packet) === 'detach') return this.detachReadonly(runtime, target);
    if (kind(packet) === 'presence') {
      this.findSession(target.id)?.presence(runtime, structuredClone(packet.presence ?? null));
      return null;
    }
    const command = packet.command ?? null;
    if (!['get_snapshot', 'get_entries', 'get_state', 'get_session_revision', 'get_tool_payload', 'get_session_stats'].includes(kind(command))) throw new Error(ownershipError());
    const session = this.findSession(target.id);
    if (session && !session.transient()) return session.execute(structuredClone(command));
    if (this.ownership().lookupSaved(target.id, true) === null) {
      if (this.ownership().removed(target.id)) {
        this.output({ type: 'session_removed', sessionId: target.id, sessionPath: target.path });
        throw new Error('This conversation has been deleted or archived');
      }
      throw new Error('Conversation storage is temporarily unavailable; try again');
    }
    return this.readSavedConversation(target, command);
  }

  private readSavedConversation(target: ReadonlyView, command: any): any {
    if (kind(command) === 'get_session_revision') return this.ownership().revision(target.id, target.path);
    if (kind(command) === 'get_tool_payload') return this.readSavedToolPayload(target, command);
    const snapshot = this.ownership().snapshot(target.id, target.path);
    switch (kind(command)) {
      case 'get_snapshot': return snapshot;
      case 'get_entries': return snapshot.history ?? null;
      case 'get_state': return snapshot.state ?? null;
      case 'get_session_stats': return { contextUsage: snapshot.state?.contextUsage ?? null };
      default: throw new Error('Unsupported saved conversation command');
    }
  }

  private readSavedToolPayload(target: ReadonlyView, command: any): any {
    const scope = 'saved:' + target.id;
    const id = text(command, 'toolCallId');
    const revision = this.ownership().revision(target.id, target.path);
    const cached = this.toolPayloads.get(scope, text(revision, 'revision'), id);
    if (cached) return cached.page(command);
    const snapshot = this.ownership().snapshot(target.id, target.path);
    const entries = Array.isArray(snapshot.history?.entries) ? snapshot.history.entries : [];
    const payload = new ToolPayload(savedToolPayload(entries, id) ?? null);
    const page = payload.page(command);
    this.toolPayloads.insert(scope, text(snapshot, 'revision'), id, payload);
    return page;
  }

  private async sessionCommand(session: Session, runtime: string, command: any): Promise<any> {
    if (kind(command) === 'abort') return queueCommand(session, command);
    if (kind(command) === 'extension_ui_response') return this.answerDialog(session, runtime, command);
    if (!kind(command).startsWith('get_') || kind(command) === 'get_snapshot') await session.reconcile(false);
    if (!kind(command).startsWith('get_')) {
      const error = session.configurationError();
      if (error !== null) throw new Error(error);
    }
    if (['fork', 'fork_after', 'clone', 'new_session', 'switch_session'].includes(kind(command))) return Branching.switchSession(this, session, runtime, command);
    if (typeof command?.clientHtmlPreviewSize === 'number') await session.raw({ type: 'html_preview_viewport', size: command.clientHtmlPreviewSize });
    return queueCommand(session, command);
  }

  private async answerDialog(session: Session, runtime: string, command: any): Promise<any> {
    const id = text(command, 'id');
    const release = await gate(this.dialogGates, session.epoch + ':' + id).lock();
    try {
      const dialog = session.dialog(id);
      if (!dialog || dialog.owner !== runtime) throw new Error('This question is no longer owned by this view. Reopen the conversation to refresh it.');
      if (typeof dialog.event?.asyncQuestion !== 'string') {
        session.resolveDialog(id);
        await session.send(command);
        return null;
      }
      const response = dialog.queuedResponse ?? session.queue.questionResponse(text(dialog.event, 'asyncQuestion'))
        ?? { type: 'answer_question', requestId: dialog.event.asyncQuestion, value: command.value ?? null, cancelled: flag(command, 'cancelled') };
      session.changeDialog(id, item => { item.answering = true; });
      try {
        const prepare = structuredClone(response);
        prepare.action = 'prepare';
        const prepared = await session.raw(prepare);
        if (typeof prepared?.message === 'string' && prepared.message && !dialog.answerQueued) {
          await session.queue.command({ type: session.working() ? 'steer' : 'follow_up', message: prepared.message, questionResponse: structuredClone(response) });
          session.changeDialog(id, item => { item.answerQueued = true; item.queuedResponse = structuredClone(response); });
        }
        const resolve = structuredClone(response);
        resolve.action = 'resolve';
        resolve.queueId = prepared?.queueId ?? null;
        await session.raw(resolve);
        return null;
      } finally { session.changeDialog(id, item => { item.answering = false; }); }
    } finally { release(); }
  }

  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    await this.services.shutdown();
    await Promise.all([...this.sessions.values()].map(session => session.stop()));
    this.ownership().shutdown();
    for (const [guard] of this.guards.values()) guard.drop();
    this.guards.clear();
  }

  // Attachment.

  async attach(packet: any): Promise<any> {
    const attachment = new Attachment(this, packet);
    if (flag(attachment.packet.presence, 'readOnly')) return attachment.readonly();
    const guard = await attachment.ownership();
    const owned = guard.owned;
    const opened: { session?: Session } = {};
    let result: any;
    let failure: unknown;
    try { result = await attachment.open(guard, opened); } catch (error) { failure = error ?? new Error('Attach failed'); }
    let releaseError: unknown;
    try { guard.release(this.ownership(), false); } catch (error) { releaseError = error; }
    await attachment.cleanup(opened.session, owned);
    if (releaseError !== undefined) throw releaseError;
    if (failure !== undefined) throw failure;
    return result;
  }

  // Requests.

  async handle(packet: any): Promise<any> {
    const runtime = text(packet, 'runtimeId');
    const name = kind(packet);
    if (DaemonRestart.blocking() && !['prepare_daemon_restart', 'plugin_status', 'detach', 'shutdown'].includes(name)) {
      throw new Error('The daemon is restarting. Reconnect before retrying.');
    }
    if (name === 'detach') this.attachments.delete(runtime);
    switch (name) {
      case 'check_daemon_idle': case 'prepare_daemon_restart': return this.restartRequest(packet);
      case 'agent_definitions': return structuredClone(this.agentDefinitions);
      case 'conversation_owner': return this.ownership().owns(text(packet, 'sessionId'), text(packet, 'clientId'), flag(packet, 'allowReleased'));
      case 'conversation_mutation': return this.beginMutation(packet);
      case 'conversation_mutation_end': return this.endMutation(packet);
      case 'provider_auth': case 'provider_auth_cancel_owner': case 'plugin_call': case 'plugin_status': return this.services.handle(packet);
      case 'configure': await this.configure(packet.configuration); return null;
      case 'attach': return this.attach(packet);
      case 'shutdown': await this.shutdown(); return null;
      case 'retire': return this.retire(packet);
      case 'session_command': return this.directSessionCommand(packet);
      case 'orchestration': return this.orchestration(packet);
    }
    return this.runtimeCommand(packet, runtime);
  }

  private async restartRequest(packet: any): Promise<any> {
    const sessions = [...this.sessions.values()];
    if (sessions.some(session => session.busy(null) || session.transient()) || this.deliveries.size || this.guards.size || this.pending.size) {
      throw new Error('Wait for active agents to finish before restarting the daemon');
    }
    return this.services.handle(kind(packet) === 'check_daemon_idle' ? { type: 'plugin_idle' } : packet);
  }

  private async orchestration(packet: any): Promise<any> {
    const id = text(packet, 'sessionKey');
    const action = text(packet, 'action');
    if (action === 'locate') return this.ownership().lookup(id);
    if (action === 'interrupt') {
      if (this.cancelDeliveries(id, typeof packet.deliveryId === 'string' ? packet.deliveryId : undefined)) return { sessionId: id, completed: false };
      return this.orchestrationCancel(id);
    }
    const location = this.ownership().lookup(id);
    if (location.archived === true && action === 'send') throw new Error('This conversation has been deleted or archived');
    const session = this.findSession(id);
    switch (action) {
      case 'read': return session ? session.execute({ type: 'get_snapshot' }) : this.ownership().snapshot(id, packet.sessionPath);
      case 'send': return this.orchestrationSend(packet, session);
      case 'recover_usage': return this.orchestrationRecoverUsage(packet, session);
      default: throw new Error('Unknown orchestration action');
    }
  }

  private cancelDeliveries(id: string, delivery: string | undefined): boolean {
    if (delivery !== undefined) this.cancelledDeliveries.add(delivery);
    const pending = [...(this.deliveries.get(id) ?? [])];
    for (const item of pending) this.cancelledDeliveries.add(item);
    return pending.length > 0;
  }

  private async orchestrationCancel(id: string): Promise<any> {
    const session = this.findSession(id);
    if (session) return this.orchestrationInterrupt(id, session);
    if (this.ownership().locate(id, null, false, true)) return this.orchestrationInterrupt(id, undefined);
    if (this.ownership().removed(id) || this.ownership().locate(id, null, true, true)) return { sessionId: id, completed: true, retired: true };
    throw new Error('Cannot confirm that this conversation has stopped or been retired');
  }

  private async orchestrationInterrupt(id: string, session: Session | undefined): Promise<any> {
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
        entry.promise = session.queue.interruptDelegation().finally(() => { entry.finished = true; });
        entry.promise.catch(() => {});
        session.orchestrationTask = entry;
      }
      return { sessionId: id, completed: false };
    } finally { release(); }
  }

  private reserveDelivery(id: string, delivery: string): void {
    if (!isUuid(delivery)) throw new Error('A valid deliveryId is required');
    if (this.cancelledDeliveries.has(delivery)) throw new Error('Agent delivery was cancelled');
    let set = this.deliveries.get(id);
    if (!set) { set = new Set(); this.deliveries.set(id, set); }
    if (set.has(delivery)) throw new Error('Agent delivery is already pending');
    set.add(delivery);
  }

  private releaseDelivery(id: string, delivery: string): void {
    const set = this.deliveries.get(id);
    if (!set) return;
    set.delete(delivery);
    if (!set.size) this.deliveries.delete(id);
  }

  private async attachHidden(packet: any, runtime: string, id: string): Promise<void> {
    const result = await this.attach({ type: 'attach', runtimeId: runtime, clientId: packet.clientId ?? null, sessionKey: id, spec: packet.spec ?? null, cwd: packet.cwd ?? null, presence: { visible: false } });
    if (!flag(result, 'owned')) {
      this.attachments.delete(runtime);
      this.readonlyMap.delete(runtime);
      throw new Error(ownershipError());
    }
  }

  private async orchestrationSend(packet: any, existing: Session | undefined): Promise<any> {
    const id = text(packet, 'sessionKey');
    const source = text(packet, 'sourceSessionId');
    if (!source || source === id) throw new Error('Choose another conversation as the recipient');
    const message = text(packet, 'message');
    if (!message.trim() || Buffer.byteLength(message) > 100_000) throw new Error('Message must contain 1–100000 bytes');
    const delivery = text(packet, 'deliveryId');
    this.reserveDelivery(id, delivery);
    try {
      const runtime = 'orchestration-' + randomUUID();
      const attached = !existing;
      if (attached) await this.attachHidden(packet, runtime, id);
      let result: any;
      let failure: unknown;
      try { result = await this.orchestrationDeliver(packet); } catch (error) { failure = error ?? new Error('Delivery failed'); }
      if (attached) {
        try { await this.orchestrationDetach(runtime); } catch (error) { if (failure === undefined) throw error; }
      }
      if (failure !== undefined) throw failure;
      return result;
    } finally { this.releaseDelivery(id, delivery); }
  }

  private async orchestrationDeliver(packet: any): Promise<any> {
    const session = this.findSession(text(packet, 'sessionKey'));
    if (!session) throw new Error('Conversation is no longer running');
    if (session.transient() || session.compacting()) throw new Error('Wait for conversation preparation or compaction to finish');
    await session.reconcile(false);
    const error = session.configurationError();
    if (error !== null) throw new Error(error);
    if (this.cancelledDeliveries.has(text(packet, 'deliveryId'))) throw new Error('Agent delivery was cancelled');
    if (flag(packet, 'wake')) await session.activateUsageRecovery();
    return queueCommand(session, { type: 'orchestration_message', deliveryId: packet.deliveryId ?? null, sourceSessionId: packet.sourceSessionId ?? null,
      sourceHostId: packet.sourceHostId ?? null, message: packet.message ?? null, wake: packet.wake ?? null });
  }

  private async orchestrationRecoverUsage(packet: any, existing: Session | undefined): Promise<any> {
    const id = text(packet, 'sessionKey');
    const runtime = 'usage-recovery-' + randomUUID();
    const attached = !existing;
    if (attached) await this.attachHidden(packet, runtime, id);
    let result: any;
    let failure: unknown;
    const session = this.findSession(id);
    try {
      if (!session) throw new Error('Conversation is no longer running');
      result = await session.execute({ type: 'recover_subagent_usage', sourceSessionId: packet.sourceSessionId ?? null, recoveryDepth: packet.recoveryDepth ?? null, deadline: packet.deadline ?? null });
    } catch (error) { failure = error ?? new Error('Usage recovery failed'); }
    if (attached) {
      try { await this.orchestrationRecoveryDetach(runtime, id); } catch (error) { if (failure === undefined) throw error; }
    }
    if (failure !== undefined) throw failure;
    return result;
  }

  private async orchestrationRecoveryDetach(runtime: string, id: string): Promise<any> {
    const release = await gate(this.sessionGates, id).lock();
    try {
      this.attachments.delete(runtime);
      const session = this.subscriptions.get(runtime);
      this.subscriptions.delete(runtime);
      if (session) {
        session.detachView(runtime);
        try { await session.retire(); } catch {}
        await this.releaseUnused(session);
      }
      return null;
    } finally { release(); }
  }

  private async orchestrationDetach(runtime: string): Promise<any> {
    this.attachments.delete(runtime);
    const session = this.subscriptions.get(runtime);
    return session ? this.detach({ preserveRunning: true }, runtime, session) : null;
  }

  private async beginMutation(packet: any): Promise<any> {
    const operation = text(packet, 'operation');
    const guard = await this.ownership().begin(text(packet, 'sessionId'), text(packet, 'clientId'), {
      mutation: true, message: operation === 'message', archive: operation === 'archive', path: packet.sessionPath ?? null, archived: packet.archived ?? null,
    });
    if (!guard.owned) { guard.drop(); throw new Error(ownershipError()); }
    const token = randomUUID();
    this.guards.set(token, [guard, operation]);
    return { token };
  }

  private async endMutation(packet: any): Promise<any> {
    const token = text(packet, 'token');
    const entry = this.guards.get(token);
    this.guards.delete(token);
    if (!entry) return null;
    const [guard, operation] = entry;
    if (operation === 'restore') {
      await guard.restoreFinished(this.ownership(), typeof packet.restoredPath === 'string' ? packet.restoredPath : null);
      return null;
    }
    const deletedId = operation === 'delete' && flag(packet, 'success') && typeof guard.saved?.header?.id === 'string' ? guard.saved.header.id : undefined;
    guard.release(this.ownership(), flag(packet, 'success') && (operation === 'delete' || operation === 'archive'));
    if (deletedId !== undefined) {
      clearSaved(this.storageRoot(), deletedId);
      this.pending.delete(deletedId);
    }
    return null;
  }

  private async retire(packet: any): Promise<any> {
    let session = this.sessions.get(text(packet, 'sessionKey'));
    if (!session) {
      for (const candidate of this.sessions.values()) {
        if (jsonEqual(candidate.savedState()?.sessionFile, packet.sessionPath) || (typeof packet.sessionPath === 'string' && candidate.reservedPath() === packet.sessionPath)) { session = candidate; break; }
      }
    }
    if (session) {
      if (flag(packet, 'archive')) await this.releaseOwnedSession(session.identity, 'archive', session);
      else await session.retire();
    }
    return null;
  }

  private async directSessionCommand(packet: any): Promise<any> {
    const session = this.sessions.get(text(packet, 'sessionKey'));
    if (!session) throw new Error('Conversation is no longer running');
    return session.execute(structuredClone(packet.command ?? null));
  }

  private async runtimeCommand(packet: any, runtime: string): Promise<any> {
    const name = kind(packet);
    if (name === 'command' && packet.command?.type === 'take_ownership') return this.takeOwnership(runtime);
    const readonly = this.readonlyMap.get(runtime);
    if (readonly) return this.readonlyCommand(packet, { ...readonly });
    const session = this.subscriptions.get(runtime);
    if (!session) {
      if (name === 'detach') return { stopped: false };
      throw new Error('Pi is not running');
    }
    if (name === 'detach') return this.detach(packet, runtime, session);
    if (name === 'presence') {
      session.presence(runtime, structuredClone(packet.presence ?? null));
      const presence = packet.presence;
      if (flag(presence, 'visible') && flag(presence, 'focused') && typeof presence?.htmlPreviewSize === 'number') {
        await session.raw({ type: 'html_preview_viewport', size: presence.htmlPreviewSize });
      }
      return null;
    }
    if (name === 'command' && packet.command?.type === 'reload_agents') return this.reloadAgents(runtime, text(packet.command, 'sessionId'));
    return this.sessionCommand(session, runtime, structuredClone(packet.command ?? null));
  }

  private async takeOwnership(runtime: string): Promise<any> {
    const current = this.attachments.get(runtime);
    if (current === undefined) throw new Error('This conversation has been deleted or closed');
    const target = structuredClone(current);
    if (flag(target.presence, 'readOnly')) throw new Error('This view is read-only');
    target.takeOwnership = true;
    return this.attach(target);
  }

  async detach(packet: any, runtime: string, session: Session): Promise<any> {
    this.subscriptions.delete(runtime);
    session.detachView(runtime);
    const result = await session.finishDetach(flag(packet, 'discardBlank'), flag(packet, 'preserveRunning'));
    await this.releaseUnused(session);
    return result;
  }

  // Queued-input recovery.

  private recoverQueuedInput(): void {
    const root = this.storageRoot();
    let recovery = recoverMissingTranscripts(root, this.ownership());
    const reported = new Set<string>();
    this.report(recovery, reported);
    if (!recovery.retry) return;
    const ownership = this.ownership();
    void (async () => {
      let delay = 1000;
      while (recovery.retry && !ownership.stopped) {
        await sleep(delay);
        if (ownership.stopped) break;
        delay = Math.min(delay * 2, 60_000);
        const pending = recovery.transactionsPending;
        try {
          if (pending) await collectRetention(root);
          recovery = recoverMissingTranscripts(root, ownership);
        } catch (error) {
          recovery = { errors: [errorText(error)], recovered: false, retry: true, transactionsPending: pending };
        }
        if (ownership.stopped) break;
        this.report(recovery, reported);
      }
    })();
  }

  private report(recovery: Recovery, reported: Set<string>): void {
    for (const error of recovery.errors) {
      if (reported.has(error)) continue;
      reported.add(error);
      this.output({ type: 'diagnostic', line: 'Queued input retained for recovery: ' + error });
    }
    if (recovery.recovered) this.output({ type: 'sessions_changed' });
  }

  // Retention.

  private watchRetention(): void {
    const root = this.storageRoot();
    let reported: string | null = null;
    let initialized = false;
    let running = false;
    const pass = async () => {
      if (running || this.ownership().stopped) return;
      running = true;
      try {
        await retentionPass(root, !initialized);
        initialized = true;
        reported = null;
      } catch (error) {
        const message = errorText(error);
        if (reported !== message) this.output({ type: 'diagnostic', line: 'Deferred retention cleanup is pending: ' + message });
        reported = message;
      } finally { running = false; }
    };
    void pass();
    const timer = setInterval(() => { void pass(); }, 30_000);
    timer.unref();
    this.timers.push(timer);
  }
}

class Attachment {
  readonly runtime: string;
  readonly spec: LaunchSpec;
  readonly identity: string;
  readonly path: string | null;

  constructor(private host: Host, readonly packet: any) {
    this.runtime = text(packet, 'runtimeId');
    host.attachments.set(this.runtime, packet);
    this.spec = parseLaunchSpec(packet.spec);
    const key = text(packet, 'sessionKey');
    this.identity = specIdentity(this.spec, key);
    if (isUuid(key) && this.identity !== key) throw new Error('The saved path belongs to another conversation; resolve its identity again');
    this.path = argument(this.spec, '--session') ?? null;
    this.assertCurrent();
  }

  private assertCurrent(): void {
    if (this.host.attachments.get(this.runtime) !== this.packet) throw new Error('The conversation was closed while attaching');
  }

  readonly(): any {
    this.host.ownership().lookup(this.identity);
    this.assertCurrent();
    return this.attachReadonly();
  }

  private attachReadonly(): any {
    this.host.readonlyMap.set(this.runtime, { id: this.identity, path: this.path });
    return { attached: true, owned: false };
  }

  ownership(): Promise<Guard> {
    return this.host.ownership().begin(this.identity, text(this.packet, 'clientId'), { take: this.packet.takeOwnership ?? null, path: this.path, create: this.path === null });
  }

  async open(guard: Guard, opened: { session?: Session }): Promise<any> {
    this.assertCurrent();
    if (!guard.owned) return this.attachReadonly();
    const release = await gate(this.host.sessionGates, this.identity).lock();
    try {
      const session = await this.session(guard);
      opened.session = session;
      await session.execute({ type: 'get_state' });
      if (typeof this.packet.presence?.htmlPreviewSize === 'number') await session.raw({ type: 'html_preview_viewport', size: this.packet.presence.htmlPreviewSize });
      this.assertCurrent();
      session.setClientId(text(this.packet, 'clientId'));
      this.host.readonlyMap.delete(this.runtime);
      this.host.attachView(this.runtime, session, structuredClone(this.packet.presence ?? null));
      this.host.remember(this.runtime, session);
      if (this.spec.env.PIOP_USAGE_RECOVERY !== '1') await session.activateUsageRecovery();
      this.host.reconcile(session);
      return { attached: session.views().length > 1 || session.submitted(), owned: true };
    } finally { release(); }
  }

  private async session(guard: Guard): Promise<Session> {
    let session = this.host.findSession(this.identity);
    if (session?.transient()) throw new Error('This conversation branch is still being prepared');
    if (session?.stopping()) {
      await session.stop();
      session = this.host.findSession(this.identity);
    }
    return session ?? this.host.spawnSession(this.launch(guard));
  }

  private launch(guard: Guard): SessionLaunch {
    const savedCwd = guard.saved?.header?.cwd;
    const raw = typeof savedCwd === 'string' ? savedCwd : (typeof this.packet.cwd === 'string' ? this.packet.cwd : null);
    const cwd = raw === null ? null : expandHome(raw, this.host.home);
    const spec: LaunchSpec = { program: this.spec.program, args: [...this.spec.args], env: { ...this.spec.env }, cwd: this.spec.cwd };
    if (spec.env.PIOP_REMOTE_SESSION_CLAIMS !== undefined) spec.env.PIOP_SESSION_CWD = cwd ?? '~';
    else if (cwd !== null) spec.cwd = cwd;
    const timeout = this.packet.timeout;
    return {
      key: this.identity, spec,
      timeout: typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 0 ? timeout : 630000,
      transient: false, clientId: text(this.packet, 'clientId'), cwd,
    };
  }

  private stillAttached(opened: Session | undefined): boolean {
    const current = this.host.subscriptions.get(this.runtime);
    return (current !== undefined && opened !== undefined && current === opened) || this.host.attachments.get(this.runtime) === this.packet;
  }

  async cleanup(opened: Session | undefined, owned: boolean): Promise<void> {
    if (this.stillAttached(opened)) return;
    if (opened) {
      if (!opened.views().length) {
        if (!opened.submitted() && !opened.working()) await opened.stop();
        else await this.host.releaseUnused(opened);
      }
    } else if (owned) {
      await this.host.ownership().releaseClient(this.identity, text(this.packet, 'clientId'), () =>
        ![...this.host.attachments.values()].some(value => jsonEqual(value?.clientId, this.packet.clientId) && jsonEqual(value?.sessionKey, this.packet.sessionKey)));
    }
  }
}

export async function queueCommand(session: Session, original: any): Promise<any> {
  const command = original;
  if (kind(command) === 'change_pending') return session.queue.changePending(text(command, 'id'), command.action ?? null);
  const message = text(command, 'message');
  const first = message.split(/\s+/).find(part => part) ?? '';
  if (first === '/goal' && Array.isArray(command.images) && command.images.length) throw new Error('Goals do not accept attachments. Remove the files and images before sending.');
  const review = first === '/review' || first === '/rs';
  if (kind(command) === 'prompt' && (!message.startsWith('/') || review) && !session.queue.held()) {
    command.type = !review && command.streamingBehavior === 'steer' ? 'steer' : 'follow_up';
  }
  return session.queue.command(command);
}

function retentionPending(root: string): boolean {
  const database = Registry.open(root);
  try {
    const row: any = database.prepare('SELECT (EXISTS(SELECT 1 FROM retention_candidates) OR EXISTS(SELECT 1 FROM cleanup_requests) OR EXISTS(SELECT 1 FROM deletion_records) OR EXISTS(SELECT 1 FROM storage_transactions)) AS pending').get();
    return Boolean(row.pending);
  } finally { database.close(); }
}

async function retentionPass(root: string, initialize: boolean): Promise<void> {
  if (initialize) {
    const database = Registry.open(root);
    try { database.prepare('INSERT INTO cleanup_requests VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1').run('goal'); } finally { database.close(); }
  }
  if (!retentionPending(root)) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Deferred retention cleanup timed out; candidates remain available for retry')), 30_000); });
  const controller = new AbortController();
  try { await Promise.race([collectRetention(root, controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Runs the storage-transaction recovery script. Exit code 75 means another process holds the work, which is fine. */
export function collectRetention(root: string, signal?: AbortSignal): Promise<void> {
  const request = JSON.stringify({ action: 'recover', root });
  const spec = nodeCommand(['-e', storageTransactionBundle, request]);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.program, spec.args ?? [], { env: { ...process.env, ...spec.env, PIOP_RESTORE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    let finished = false;
    const kill = () => { if (!finished && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout!.resume();
    child.stderr!.on('data', chunk => { if (stderr.length < 65536) stderr += chunk; });
    child.on('error', error => { finished = true; reject(error); });
    child.on('close', code => {
      finished = true;
      signal?.removeEventListener('abort', kill);
      if (code === 0 || code === 75) resolve();
      else reject(new Error('Session storage recovery is pending: ' + stderr.trim()));
    });
  });
}
