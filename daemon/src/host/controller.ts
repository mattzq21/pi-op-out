import { read as readGoal } from "../../resources/piop-storage/goals.cjs";
import { join } from 'node:path';
import { getProjectRepository, refreshProjectRepository } from '../project_repositories';
import { saveProgress } from '../chat_worktrees';
import * as Registry from '../session_registry';
import * as Settings from '../settings';
import * as Extensions from '../extensions';
import { recordTools } from '../tool_inventory';
import { recordCommands } from '../command_inventory';
import * as DaemonRestart from '../daemon_restart';
import { Mutex, errorText } from '../util/sync';
import { flag, kind, text, jsonEqual } from './json';
import * as Agents from './agents';
import { attach } from './attachment';
import { lockGate } from './lock_gate';
import { MutationGuards } from './mutation_guards';
import { Orchestration } from './orchestration';
import { ConversationOwnership, ownershipError } from './ownership';
import { clientPayload } from './payload';
import { argument, sessionSpec, serializeSpec, type SessionLaunch } from './protocol';
import { drainSaves } from './queue_storage';
import { readonlyCommand, type ReadonlyView } from './readonly_views';
import { parseRuntimeEvent, type RuntimeEvent, type RuntimeEventSource } from './runtime_events';
import { Session, type SessionHost } from './session';
import { sessionCommand } from './session_commands';
import { recoverQueuedInput, watchRetention } from './storage_upkeep';
import { ToolPayloadCache } from './tool_payload';
import type { HostServices } from './services';

export class Host implements SessionHost {
  sessions = new Map<string, Session>();
  subscriptions = new Map<string, Session>();
  attachments = new Map<string, any>();
  /** The session epoch that each remembered attachment record belongs to. */
  private attachmentEpochs = new WeakMap<object, string>();
  readonlyMap = new Map<string, ReadonlyView>();
  pending = new Map<string, any[]>();
  configurationValue: any | null = null;
  agentDefinitions: any = null;
  agentRevision = 0;
  requestedAgentRevision = 0;
  maintenanceSet = new Set<string>();
  releaseGates = new Map<string, Mutex>();
  dialogGates = new Map<string, Mutex>();
  sessionGates = new Map<string, Mutex>();
  private spawnGates = new Map<string, Mutex>();
  private shuttingDown = false;
  private starts = new Set<Promise<Session>>();
  private finishes = new Map<Session, Promise<void>>();
  private configurationGate = new Mutex();
  private ownershipValue: ConversationOwnership | undefined;
  readonly toolPayloads = new ToolPayloadCache();
  readonly orchestration = new Orchestration(this);
  private mutations = new MutationGuards(this);
  private timers: NodeJS.Timeout[] = [];

  private constructor(readonly home: string, readonly storage: string, readonly services: HostServices, private sink: (packet: any) => void) {}

  static async create(home: string, storage: string, services: HostServices, sink: (packet: any) => void): Promise<Host> {
    const settings = Settings.readSettingsAt(join(home, storage, 'settings.json'));
    const definitions = await Agents.load(home, storage, Extensions.agentResources(settings), true, null);
    const host = new Host(home, storage, services, sink);
    host.agentDefinitions = definitions;
    host.ownershipValue = await ConversationOwnership.create(home, storage, { revoke: (id, intent) => host.releaseConversation(id, intent) });
    const output = (packet: any) => host.output(packet);
    recoverQueuedInput(host.storageRoot(), host.ownership(), output);
    services.bind(host);
    await services.initialize();
    host.timers.push(watchRetention(host.storageRoot(), host.ownership(), output));
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
  finished(key: string, epoch: string, transient: boolean): void {
    const session = this.sessions.get(key);
    if (session?.epoch !== epoch) return;
    const finished = (async () => {
      await session.drain();
      if (this.sessions.get(session.key) !== session) return;
      const retained = session.queue.saved() ? [] : session.queue.pending();
      if (retained.length) this.pending.set(session.key, retained);
      else this.pending.delete(session.key);
      for (const [runtime, current] of this.subscriptions) {
        if (current !== session) continue;
        this.subscriptions.delete(runtime);
        // Owning views receive "disconnected" and the app forgets them, so no detach will come to remove their attachment.
        // Read-only views stay registered in the app and keep their attachment for a later take-ownership.
        // A view that reconnects meanwhile has a new record without this epoch, so it is kept.
        const record = this.attachments.get(runtime);
        if (!this.readonlyMap.has(runtime) && record && this.attachmentEpochs.get(record) === session.epoch) this.attachments.delete(runtime);
      }
      if (!transient) {
        this.output({ type: 'session_closed', sessionKey: session.key, epoch, state: session.savedState(), submitted: session.submitted() });
      }
      this.sessions.delete(session.key);
    })();
    this.finishes.set(session, finished);
    void finished.then(() => { this.finishes.delete(session); }, error => {
      this.finishes.delete(session);
      console.error('Queue shutdown failed for ' + key + ': ' + errorText(error));
      this.output({ type: 'diagnostic', line: 'Queue shutdown failed for ' + key + ': ' + errorText(error) });
    });
  }
  maintenance(key: string): void { this.maintain(key); }
  refreshProviders(): Promise<number> { return this.services.refreshProviders(); }

  /**
   * tools_available saves the tools that a starting Pi offers on this host. commands_available saves its extension commands.
   * task_success commits a chat's repository on Pi's final response, before Pi takes a follow-up (ADR 0006). Uses the saved repository status.
   */
  async runtimeEvent(source: RuntimeEventSource, event: RuntimeEvent): Promise<void> {
    if (event.name === 'tools_available') { recordTools(event.data.tools, join(this.home, this.storage, 'settings.json')); return; }
    if (event.name === 'commands_available') { recordCommands(event.data.commands, join(this.home, this.storage, 'settings.json')); return; }
    if (event.name !== 'task_success' || source.cwd === null) return;
    const repository = getProjectRepository(this.storageRoot(), source.cwd);
    if (!repository) return;
    await saveProgress(source.cwd, { repository: repository.root, gitCommonDir: repository.gitDir });
  }

  /** A runtime event from an agent that runs for one message, through the session broker. */
  private async brokerRuntimeEvent(packet: any): Promise<null> {
    const event = parseRuntimeEvent(packet.event);
    const identity = text(event.data, 'sessionId');
    const cwd = text(event.data, 'cwd');
    if (!identity || !cwd) throw new Error('Runtime event ' + event.name + ' has no chat');
    try { await this.runtimeEvent({ sessionKey: identity, identity, cwd }, event); }
    catch (error) {
      this.output({ type: 'diagnostic', line: identity + ': ' + event.name + ' failed: ' + errorText(error) });
      throw error;
    }
    return null;
  }

  stateChanged(identity: string): void { this.orchestration.stateChanged(identity); }

  findSession(identity: string): Session | undefined {
    for (const session of this.sessions.values()) if (session.identity === identity && !session.closed()) return session;
    return undefined;
  }

  current(runtime: string, session: Session): boolean { return this.subscriptions.get(runtime)?.epoch === session.epoch; }

  assertRunning(): void {
    if (this.shuttingDown) throw new Error('Cannot start a session: the host is shutting down');
  }

  spawnSession(launch: SessionLaunch): Promise<Session> {
    const start = this.startSession(launch);
    this.starts.add(start);
    void start.then(() => { this.starts.delete(start); }, error => {
      this.starts.delete(start);
      if (this.shuttingDown) console.error('Session start failed during shutdown: ' + errorText(error));
    });
    return start;
  }

  private async startSession(launch: SessionLaunch): Promise<Session> {
    this.assertRunning();
    const key = launch.key;
    const release = await lockGate(this.spawnGates, key);
    try {
      this.assertRunning();
      let existing = this.sessions.get(key) ?? this.findSession(key);
      if (existing && (existing.closed() || existing.stopping())) {
        await existing.stop();
        await this.finishes.get(existing);
        this.assertRunning();
        existing = this.findSession(key);
      }
      if (existing) {
        if (launch.transient) throw new Error('The prepared branch identity is already in use');
        if (existing.transient()) throw new Error('This conversation branch is still being prepared');
        return existing;
      }
      if (!argument(launch.spec, '--session') && launch.cwd) {
        const db = Registry.open(this.storageRoot());
        let saved: unknown;
        try { saved = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(key); }
        finally { db.close(); }
        if (!(saved as any)?.session_path) await refreshProjectRepository(this.storageRoot(), launch.cwd);
      }
      const pending = this.pending.get(key) ?? [];
      this.pending.delete(key);
      let session: Session;
      try { session = await Session.spawn(launch, structuredClone(pending), this, this.home, this.toolPayloads, () => this.assertRunning()); }
      catch (error) { if (pending.length) this.pending.set(key, pending); throw error; }
      this.sessions.set(key, session);
      this.stateChanged(session.identity);
      return session;
    } finally { release(); }
  }

  remember(runtime: string, session: Session): void {
    const saved = session.savedState();
    const spec = sessionSpec(session.spec, '--session-id', typeof saved?.sessionId === 'string' ? saved.sessionId : session.identity);
    const packet = structuredClone(this.attachments.get(runtime) ?? {});
    packet.spec = serializeSpec(spec);
    packet.sessionKey = session.identity;
    packet.cwd = session.cwd;
    this.attachments.set(runtime, packet);
    this.attachmentEpochs.set(packet, session.epoch);
  }

  attachView(runtime: string, session: Session, presence: any): void {
    this.subscriptions.set(runtime, session);
    session.attach(runtime, presence);
  }

  forgetWorker(session: Session): void {
    if (this.finishes.has(session)) return;
    const key = session.key;
    if (this.sessions.get(key)?.epoch === session.epoch) this.sessions.delete(key);
  }

  private maintain(key: string): void {
    const session = this.sessions.get(key);
    if (!session || this.maintenanceSet.has(session.epoch)) return;
    this.maintenanceSet.add(session.epoch);
    void (async () => {
      await session.settings.reconcile(false);
      try { await this.releaseUnused(session); } catch (error) {
        this.output({ type: 'diagnostic', line: 'Could not release unused ownership for ' + session.key + ': ' + errorText(error) });
      }
      this.maintenanceSet.delete(session.epoch);
    })();
  }

  async releaseUnused(session: Session): Promise<void> {
    session.idleStop.schedule();
    if (session.unused()) await this.ownership().releaseClient(session.identity, session.clientId(), () => session.unused());
  }

  canStopIdle(session: Session): boolean {
    if (this.shuttingDown || this.sessions.get(session.key) !== session || this.orchestration.delivering(session.identity)
      || this.readonlyViews(session.identity).length
      || [...this.attachments.values()].some(packet => packet.sessionKey === session.identity)) return false;
    const database = Registry.open(this.storageRoot());
    try {
      const id = session.identity;
      const file = session.savedState()?.sessionFile;
      const goal = typeof file === 'string' ? readGoal(file) : null;
      if (goal && goal.status !== 'complete') return false;
      if (database.prepare('SELECT 1 FROM session_mailbox WHERE session_id=? LIMIT 1').get(id)) return false;
      const runs = database.prepare('SELECT run_json FROM session_subagent_runs WHERE session_id=?').all(id);
      return !runs.some(row => {
        const run = JSON.parse(String(row.run_json));
        return run.status === 'running' || run.resultDelivery === 'pending';
      });
    } finally { database.close(); }
  }

  reconcile(session: Session): void {
    void (async () => {
      await session.settings.reconcile(true);
      try { await this.releaseUnused(session); } catch {}
    })();
  }

  async releaseConversation(id: string, intent: string): Promise<void> {
    const release = await lockGate(this.releaseGates, id);
    try {
      const sessions = [...this.sessions.values()].filter(session => session.identity === id);
      for (const session of sessions) await this.releaseOwnedSession(id, intent, session);
    } finally { release(); }
  }

  async releaseOwnedSession(id: string, intent: string, session: Session): Promise<void> {
    if (intent === 'transfer' && (session.working() || session.compacting())) {
      throw new Error('The agent is running on another daemon. Wait for it to finish before transferring ownership.');
    }
    const saved = session.savedState();
    for (const [runtime] of session.views()) this.readonlyMap.set(runtime, { id, path: typeof saved?.sessionFile === 'string' ? saved.sessionFile : null });
    session.publish({ type: 'ownership_lost' }, null);
    if (intent === 'transfer-local') return;
    if (!['archive', 'delete', 'relocate'].includes(intent) && (session.working() || session.compacting())) { try { await session.raw({ type: 'abort' }); } catch {} }
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
      const definitions = changed ? await Agents.load(this.home, this.storage, configuration.settings, false, this.services.fastModels()) : undefined;
      if (definitions !== undefined) { this.agentDefinitions = definitions; this.agentRevision += 1; }
      this.requestedAgentRevision = revision;
      const next = structuredClone(configuration);
      next.agentRevision = this.agentRevision;
      this.configurationValue = next;
      sessions = [...this.sessions.values()];
    } finally { release(); }
    for (const session of sessions) {
      session.publish({ type: 'settings_pending', pending: session.settings.pending() }, null);
      this.reconcile(session);
    }
  }

  private async reloadAgents(runtime: string, sessionId: string): Promise<any> {
    const revision = await this.reloadAgentDefinitions(() => this.agentReloadTarget(runtime, sessionId));
    return { success: true, sessionId, agentRevision: revision };
  }

  /** Reads the agent definitions again and applies them to every session. `target` must stay the same while they load. */
  private async reloadAgentDefinitions(target: () => unknown = () => undefined): Promise<number> {
    const release = await this.configurationGate.lock();
    let revision: number;
    let sessions: Session[];
    try {
      const before = target();
      if (this.configurationValue === null) throw new Error('Daemon is not configured');
      const settings = structuredClone(this.configurationValue.settings ?? null);
      const definitions = await Agents.load(this.home, this.storage, settings, false, this.services.fastModels());
      if (before !== target()) throw new Error('The session changed while loading agent definitions. Reload from its current host.');
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
    return revision;
  }

  private agentReloadTarget(runtime: string, sessionId: string): Session {
    if (this.readonlyMap.has(runtime)) throw new Error(ownershipError());
    const session = this.subscriptions.get(runtime);
    if (!session || session.identity !== sessionId || session.closed()) throw new Error('The session changed. Reload agent definitions from its current host.');
    return session;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.timers) clearInterval(timer);
    await this.services.shutdown();
    await Promise.allSettled([...this.starts]);
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map(session => session.stop()));
    await Promise.all(sessions.map(session => session.queue.drain()));
    while (this.finishes.size) await Promise.allSettled([...this.finishes.values()]);
    await drainSaves(this.storageRoot());
    this.ownership().shutdown();
    this.mutations.dropAll();
  }

  // Requests.

  async handle(packet: any): Promise<any> {
    const runtime = text(packet, 'runtimeId');
    const name = kind(packet);
    if ((await DaemonRestart.blocking()) && !['prepare_daemon_restart', 'plugin_status', 'detach', 'shutdown'].includes(name)) {
      throw new Error('The daemon is restarting. Reconnect before retrying.');
    }
    if (name === 'detach') this.attachments.delete(runtime);
    switch (name) {
      case 'check_daemon_idle': case 'prepare_daemon_restart': return this.restartRequest(packet);
      case 'agent_definitions': if (flag(packet, 'reload')) await this.reloadAgentDefinitions(); return structuredClone(this.agentDefinitions);
      case 'conversation_owner': return this.ownership().owns(text(packet, 'sessionId'), text(packet, 'clientId'), flag(packet, 'allowReleased'));
      case 'conversation_mutation': return this.mutations.begin(packet);
      case 'conversation_mutation_end': return this.mutations.end(packet);
      case 'provider_auth': case 'provider_auth_cancel_owner': case 'plugin_status': return this.services.handle(packet);
      case 'configure': await this.configure(packet.configuration); return null;
      case 'attach': return attach(this, packet);
      case 'shutdown': await this.shutdown(); return null;
      case 'retire': return this.retire(packet);
      case 'runtime_event': return this.brokerRuntimeEvent(packet);
      case 'session_command': return this.directSessionCommand(packet);
      case 'orchestration': return this.orchestration.handle(packet);
    }
    return this.runtimeCommand(packet, runtime);
  }

  private async restartRequest(packet: any): Promise<any> {
    const sessions = [...this.sessions.values()];
    if (sessions.some(session => session.busy(null) || session.transient()) || this.orchestration.busy() || this.mutations.active()) {
      throw new Error('Wait for active agents to finish before restarting the daemon');
    }
    return kind(packet) === 'check_daemon_idle' ? true : this.services.handle(packet);
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
    if (readonly) return readonlyCommand(this, packet, { ...readonly });
    const session = this.subscriptions.get(runtime);
    if (!session) {
      if (name === 'detach') return { stopped: false };
      throw new Error('Pi is not running');
    }
    if (name === 'detach') return this.detach(packet, runtime, session);
    if (name === 'presence') {
      session.presence(runtime, structuredClone(packet.presence ?? null));
      return null;
    }
    if (name === 'command' && packet.command?.type === 'reload_agents') return this.reloadAgents(runtime, text(packet.command, 'sessionId'));
    return sessionCommand(this, session, runtime, structuredClone(packet.command ?? null));
  }

  private async takeOwnership(runtime: string): Promise<any> {
    const current = this.attachments.get(runtime);
    if (current === undefined) throw new Error('This conversation has been deleted or closed');
    const target = structuredClone(current);
    if (flag(target.presence, 'readOnly')) throw new Error('This view is read-only');
    target.takeOwnership = true;
    return attach(this, target);
  }

  async detach(packet: any, runtime: string, session: Session): Promise<any> {
    this.subscriptions.delete(runtime);
    session.detachView(runtime);
    const result = await session.finishDetach(flag(packet, 'discardBlank'), flag(packet, 'preserveRunning'));
    await this.releaseUnused(session);
    return result;
  }
}
