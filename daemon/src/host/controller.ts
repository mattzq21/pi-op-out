import { join } from 'node:path';
import { CommandRefusedError } from '../pi_rejection';
import { refreshProjectRepository } from '../projects';
import * as Registry from '../session_registry';
import * as SessionTables from '../../resources/session-database.ts';
import * as Settings from '../settings';
import * as Extensions from '../extensions';
import { recordTools, recordCommands, savedCommands } from '../inventories';
import * as DaemonRestart from '../restart';
import { Mutex, errorText } from '../util/sync';
import { flag, kind, text, jsonEqual } from './json';
import * as Agents from './agents';
import { attach } from './attachment';
import { previewPrompt, stopPromptPreviews } from './prompt_preview';
import { forkFromView } from './branching';
import { KeyedLocks } from './lock_gate';
import { ClientViews } from './client_views';
import { MutationGuards } from './mutation_guards';
import { MessagePins } from './message_pins';
import { Orchestration } from './orchestration';
import { ConversationOwnership, ownershipError } from './ownership';
import { clientPayload } from './payload';
import { clientEvents, type HostEvents } from './events';
import type { AttachRequest, HostConfiguration, MutationEnd, MutationRequest, OrchestrationRequest } from './requests';
import { argument, sessionSpec, serializeSpec, type SessionLaunch } from './protocol';
import { drainSaves } from './queue';
import { detachReadonly, readonlyCommand, readonlyPresence } from './readonly_views';
import type { RuntimeEvent, RuntimeEventSource } from './runtime_events';
import { Session, type SessionHost, sessionCommand } from './session';
import { recoverQueuedInput, watchRetention } from './storage_upkeep';
import { SubmissionLedger } from './submissions';
import { ToolPayloadCache } from './tool_payload';
import type { HostServices } from './services';
import type { BrokerCall } from '../broker';

export class Host implements SessionHost {
  private sessions = new Map<string, Session>();
  readonly views = new ClientViews();
  // Queued input of conversations that are not running, kept until they start again.
  private pending = new Map<string, any[]>();
  private configurationValue: any | null = null;
  private agentDefinitions: any = null;
  private agentRevision = 0;
  private maintenanceSet = new Set<string>();
  private releaseLocks = new KeyedLocks();
  private dialogLocks = new KeyedLocks();
  private sessionLocks = new KeyedLocks();
  private spawnLocks = new KeyedLocks();
  private shuttingDown = false;
  private stopped: Promise<void> | undefined;
  private starts = new Set<Promise<Session>>();
  private finishes = new Map<Session, Promise<void>>();
  private configurationGate = new Mutex();
  private ownershipValue: ConversationOwnership | undefined;
  readonly toolPayloads = new ToolPayloadCache();
  readonly orchestration = new Orchestration(this);
  readonly pins = new MessagePins(this);
  private mutations = new MutationGuards(this);
  private stopRetention?: () => void;
  readonly submissions: SubmissionLedger;

  readonly events: HostEvents;

  private constructor(readonly home: string, readonly storage: string, readonly services: HostServices, listener: HostEvents, readonly broker: BrokerCall) {
    this.events = clientEvents(listener);
    this.submissions = new SubmissionLedger(join(home, storage), line => this.events.diagnostic(line));
  }

  static async create(home: string, storage: string, services: HostServices, listener: HostEvents, broker: BrokerCall): Promise<Host> {
    await services.initialize();
    const settings = Settings.readSettingsAt(join(home, storage));
    const definitions = await Agents.load(home, storage, Extensions.agentResources(settings), true, null);
    const host = new Host(home, storage, services, listener, broker);
    host.agentDefinitions = definitions;
    host.ownershipValue = await ConversationOwnership.create(home, storage, { revoke: (id, intent) => host.releaseConversation(id, intent) });
    try { host.submissions.recover(); } catch (error) { host.events.diagnostic('Could not decide the messages left from the last run: ' + errorText(error)); }
    recoverQueuedInput(host.storageRoot(), host.ownership(), host.events);
    services.bind(host);
    host.stopRetention = watchRetention(host.storageRoot(), host.ownership(), host.events);
    return host;
  }

  storageRoot(): string { return join(this.home, this.storage); }
  ownership(): ConversationOwnership { return this.ownershipValue!; }

  queueRoot(): string | null { return join(this.home, this.storage, 'queued-input'); }
  configuration(): any | null { return this.configurationValue === null ? null : structuredClone(this.configurationValue); }
  readonlyViews(identity: string): string[] { return this.views.readonlyRuntimes(identity); }
  readonly(runtime: string): boolean { return this.views.readonly(runtime) !== undefined; }
  hasSession(key: string): boolean { return this.sessions.has(key); }
  allSessions(): Session[] { return [...this.sessions.values()]; }
  // Serializes opening a conversation, and answering one dialog of a session.
  lockSession(identity: string): Promise<() => void> { return this.sessionLocks.lock(identity); }
  lockDialog(key: string): Promise<() => void> { return this.dialogLocks.lock(key); }
  dropQueuedInput(key: string): void { this.pending.delete(key); }
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
      this.views.sessionClosed(session);
      if (!transient) {
        this.events.sessionClosed({ sessionKey: session.key, epoch, state: session.savedState(), submitted: session.submitted() });
      }
      this.sessions.delete(session.key);
    })();
    this.finishes.set(session, finished);
    void finished.then(() => { this.finishes.delete(session); }, error => {
      this.finishes.delete(session);
      console.error('Queue shutdown failed for ' + key + ': ' + errorText(error));
      this.events.diagnostic('Queue shutdown failed for ' + key + ': ' + errorText(error));
    });
  }
  maintenance(key: string): void { this.maintain(key); }
  refreshProviders(): Promise<number> { return this.services.refreshProviders(); }

  async runtimeEvent(_source: RuntimeEventSource, event: RuntimeEvent): Promise<void> {
    if (event.name === 'tools_available') { recordTools(event.data.tools, join(this.home, this.storage)); return; }
    if (event.name === 'commands_available') { recordCommands(event.data.commands, join(this.home, this.storage)); return; }
  }

  stateChanged(identity: string): void { this.orchestration.stateChanged(identity); }

  taskRunning(id: string, running: boolean, stopped: boolean): void {
    if (stopped && this.shuttingDown) return;
    try { Registry.setTaskRunning(this.storageRoot(), id, running); }
    catch (error) { this.events.diagnostic(id + ': could not record whether its task runs: ' + errorText(error)); }
  }

  findSession(identity: string): Session | undefined {
    for (const session of this.sessions.values()) if (session.identity === identity && !session.closed()) return session;
    return undefined;
  }

  current(runtime: string, session: Session): boolean { return this.views.isCurrent(runtime, session); }

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
    const release = await this.spawnLocks.lock(key);
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
        if (!SessionTables.lookup(this.storageRoot(), key)) await refreshProjectRepository(this.storageRoot(), launch.cwd);
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
    const packet = structuredClone(this.views.request(runtime) ?? {});
    packet.spec = serializeSpec(spec);
    packet.sessionKey = session.identity;
    packet.cwd = session.cwd;
    this.views.setRequest(runtime, packet, session.epoch);
  }

  attachView(runtime: string, session: Session, presence: any): void {
    this.views.subscribe(runtime, session);
    session.attach(runtime, presence);
    this.pins.attached(runtime, session.identity);
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
        this.events.diagnostic('Could not release unused ownership for ' + session.key + ': ' + errorText(error));
      }
      this.maintenanceSet.delete(session.epoch);
    })();
  }

  async releaseUnused(session: Session): Promise<void> {
    session.idleStop.schedule();
    if (session.unused()) await this.ownership().releaseClient(session.identity, session.clientId(), () => session.unused());
  }

  extensionCommand(name: string): boolean {
    return savedCommands(join(this.home, this.storage))?.some(command => command.name === name) ?? false;
  }

  canStopIdle(session: Session): boolean {
    if (this.shuttingDown || this.sessions.get(session.key) !== session || this.orchestration.delivering(session.identity)
      || this.readonlyViews(session.identity).length
      || this.views.requestedFor(session.identity)) return false;
    const root = this.storageRoot();
    const id = session.identity;
    if (session.queue.liveGoal()) return false;
    if (SessionTables.mailboxHasMessages(root, id)) return false;
    return !SessionTables.subagentRunBodies(root, id).some(body => {
      const run = JSON.parse(body);
      return run.status === 'running' || run.resultDelivery === 'pending';
    });
  }

  reconcile(session: Session): void {
    void (async () => {
      await session.settings.reconcile(true);
      try { await this.releaseUnused(session); } catch (error) { this.events.diagnostic(session.identity + ': could not release an unused conversation: ' + errorText(error)); }
    })();
  }

  async releaseConversation(id: string, intent: string): Promise<void> {
    const release = await this.releaseLocks.lock(id);
    try {
      const sessions = [...this.sessions.values()].filter(session => session.identity === id);
      for (const session of sessions) await this.releaseOwnedSession(id, intent, session);
    } finally { release(); }
  }

  async releaseOwnedSession(id: string, intent: string, session: Session): Promise<void> {
    if (intent === 'transfer' && (session.working() || session.compacting())) {
      throw new Error('The agent is working. Wait for it to finish before changing this conversation.');
    }
    const saved = session.savedState();
    for (const [runtime] of session.views()) {
      if (this.views.readonly(runtime)) continue;
      this.views.showReadonly(runtime, { id, path: typeof saved?.sessionFile === 'string' ? saved.sessionFile : null });
      this.events.runtimeEvent(runtime, { type: 'ownership_lost' });
    }
    if (intent === 'transfer-local') return;
    if (!['archive', 'delete', 'relocate'].includes(intent) && (session.working() || session.compacting())) { try { await session.raw({ type: 'abort' }); } catch (error) { this.events.diagnostic(id + ': could not abort the response before stopping: ' + errorText(error)); } }
    await session.stop();
    if (intent === 'archive') this.pending.delete(session.key);
  }

  private async configure(configuration: HostConfiguration): Promise<void> {
    if (!configuration?.settings || typeof configuration.settings !== 'object' || Array.isArray(configuration.settings)
      || typeof configuration.autoCompaction !== 'boolean' || typeof configuration.autoRetry !== 'boolean') {
      throw new Error('Invalid daemon configuration');
    }
    const release = await this.configurationGate.lock();
    let sessions: Session[];
    try {
      const next = { ...structuredClone(configuration), agentRevision: this.agentRevision };
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

  private reloadAgentDefinitions(target: () => unknown = () => undefined): Promise<number> {
    return this.useAgentDefinitions(settings => Agents.load(this.home, this.storage, settings, false, this.services.fastModels()), target);
  }

  private async useAgentDefinitions(read: (settings: any) => Promise<any>, target: () => unknown = () => undefined): Promise<number> {
    const release = await this.configurationGate.lock();
    let revision: number;
    let sessions: Session[];
    try {
      const before = target();
      if (this.configurationValue === null) throw new Error('Daemon is not configured');
      const settings = structuredClone(this.configurationValue.settings ?? null);
      const definitions = await read(settings);
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

  private availability: Promise<void> | null = null;
  private availabilityPending = false;

  refreshAgentAvailability(): void {
    if (this.configurationValue === null) return;
    if (this.availability) { this.availabilityPending = true; return; }
    this.availability = (async () => {
      do {
        this.availabilityPending = false;
        try { await this.reloadAgentDefinitions(); this.events.agentDefinitionsChanged(); }
        catch (error) { this.events.diagnostic('Could not update which agents can run: ' + errorText(error)); }
      } while (this.availabilityPending);
    })().finally(() => { this.availability = null; });
  }

  private projectAgentDefinitions(cwd: string): Promise<any> {
    if (this.configurationValue === null) throw new Error('Daemon is not configured');
    const settings = structuredClone(this.configurationValue.settings ?? null);
    return Agents.load(this.home, this.storage, settings, false, this.services.fastModels(), { cwd, global: this.agentDefinitions });
  }

  private async saveAgentDefinitions(configuration: unknown, cwd?: string): Promise<{ revision: string; warnings: string[] }> {
    let saved: Agents.Saved | undefined;
    await this.useAgentDefinitions(async settings => {
      saved = await Agents.save(this.home, this.storage, settings, configuration, this.services.fastModels(), cwd ? { cwd, global: this.agentDefinitions } : undefined);
      return saved.definitions;
    });
    this.events.agentDefinitionsChanged();
    return { revision: saved!.revision, warnings: saved!.warnings };
  }

  private async moveAgent(agent: string, revision: string, from: string | null, to: string | null): Promise<{ revision: string; warnings: string[] }> {
    let saved: Agents.Saved | undefined;
    await this.useAgentDefinitions(async settings => {
      saved = await Agents.move(this.home, this.storage, settings, this.services.fastModels(), { global: this.agentDefinitions, agent, revision, from, to });
      return saved.definitions;
    });
    this.events.agentDefinitionsChanged();
    return { revision: saved!.revision, warnings: saved!.warnings };
  }

  private agentReloadTarget(runtime: string, sessionId: string): Session {
    if (this.readonly(runtime)) throw new Error(ownershipError());
    const session = this.views.session(runtime);
    if (!session || session.identity !== sessionId || session.closed()) throw new Error('The session changed. Reload agent definitions from its current host.');
    return session;
  }

  // Stops every session once; later calls wait for the same stop.
  shutdown(): Promise<void> { return this.stopped ??= this.stop(); }

  private async stop(): Promise<void> {
    this.shuttingDown = true;
    this.stopRetention?.();
    await this.services.shutdown();
    await stopPromptPreviews();
    await Promise.allSettled([...this.starts]);
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map(session => session.stop()));
    await Promise.all(sessions.map(session => session.queue.drain()));
    while (this.finishes.size) await Promise.allSettled([...this.finishes.values()]);
    await drainSaves(this.storageRoot());
    this.ownership().shutdown();
    this.mutations.dropAll();
  }

  // A daemon restart lets only these run: the rest would change what the restart hands over.
  private async open<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    if (this.shuttingDown) throw new Error('The host is shutting down');
    if (!['prepare_daemon_restart', 'plugin_status', 'detach'].includes(name) && await DaemonRestart.blocking()) {
      throw new Error('The daemon is restarting. Reconnect before retrying.');
    }
    return work();
  }

  checkIdle(): Promise<true> { return this.open('check_daemon_idle', () => { this.assertIdle(); return true as const; }); }

  prepareRestart(request: { enabled: string[]; revision: string }): Promise<{ enabled: string[]; previous: string[] }> {
    return this.open('prepare_daemon_restart', () => { this.assertIdle(); return this.services.prepareRestart(request); });
  }

  agentDefinitionsFor(reload: boolean, cwd?: string): Promise<any> {
    return this.open('agent_definitions', async () => {
      if (reload) await this.reloadAgentDefinitions();
      return cwd ? this.projectAgentDefinitions(cwd) : structuredClone(this.agentDefinitions);
    });
  }

  saveAgents(configuration: unknown, cwd?: string): Promise<{ revision: string; warnings: string[] }> {
    return this.open('save_agent_definitions', () => this.saveAgentDefinitions(configuration, cwd));
  }

  previewAgentPrompt(spec: unknown, agent: string): Promise<unknown> {
    return this.open('agent_prompt_preview', () => previewPrompt(spec, agent, this.home, this.storageRoot()));
  }

  moveAgentDefinition(agent: string, revision: string, from: string | null, to: string | null): Promise<{ revision: string; warnings: string[] }> {
    return this.open('move_agent', () => this.moveAgent(agent, revision, from, to));
  }

  conversationOwner(sessionId: string, clientId: string, allowReleased: boolean): Promise<boolean> {
    return this.open('conversation_owner', () => this.ownership().owns(sessionId, clientId, allowReleased));
  }

  submissionOutcome(submissionId: string): Promise<any> {
    return this.open('submission_outcome', () => this.submissions.outcome(submissionId));
  }

  beginMutation(request: MutationRequest): Promise<any> { return this.open('conversation_mutation', () => this.mutations.begin(request)); }

  endMutation(request: MutationEnd): Promise<any> { return this.open('conversation_mutation_end', () => this.mutations.end(request)); }

  providerAuth(owner: string, request: unknown): Promise<any> { return this.open('provider_auth', () => this.services.providerAuth(owner, request)); }

  cancelProviderAuth(owner: string): Promise<void> { return this.open('provider_auth_cancel_owner', () => this.services.cancelProviderAuth(owner)); }

  pluginStatus(): Promise<any> { return this.open('plugin_status', () => this.services.pluginStatus()); }
  pluginClient(id: string): Promise<{ source: string }> { return this.open('plugin_client', () => this.services.pluginClient(id)); }

  applyConfiguration(configuration: HostConfiguration): Promise<void> { return this.open('configure', () => this.configure(configuration)); }

  // attach, orchestrate and command give Pi's data, in the form for clients: see clientPayload.
  attach(request: AttachRequest): Promise<any> { return this.open('attach', async () => clientPayload(await attach(this, request))); }

  retire(sessionKey: string, sessionPath: string | null, archive: boolean): Promise<null> { return this.open('retire', () => this.retireSession(sessionKey, sessionPath, archive)); }

  orchestrate(request: OrchestrationRequest): Promise<any> { return this.open('orchestration', async () => clientPayload(await this.orchestration.handle(request))); }

  detachRuntime(runtimeId: string, discardBlank: boolean, preserveRunning: boolean): Promise<any> {
    return this.open('detach', () => {
      this.views.dropRequest(runtimeId);
      const readonly = this.views.readonly(runtimeId);
      if (readonly) return detachReadonly(this, runtimeId, readonly);
      const session = this.views.session(runtimeId);
      return session ? this.detach(runtimeId, session, discardBlank, preserveRunning) : { stopped: false };
    });
  }

  presence(runtimeId: string, presence: unknown): Promise<null> {
    return this.open('presence', () => {
      const readonly = this.views.readonly(runtimeId);
      if (readonly) return readonlyPresence(this, runtimeId, presence, readonly);
      this.running(runtimeId).presence(runtimeId, structuredClone(presence ?? null));
      return null;
    });
  }

  command(runtimeId: string, command: any): Promise<any> { return this.open('command', async () => clientPayload(await this.runtimeCommand(runtimeId, command))); }

  private assertIdle(): void {
    const sessions = [...this.sessions.values()];
    if (sessions.some(session => session.busy(null) || session.transient()) || this.orchestration.busy() || this.mutations.active()) {
      throw new Error('Wait for active agents to finish before restarting the daemon');
    }
  }

  private async retireSession(sessionKey: string, sessionPath: string | null, archive: boolean): Promise<null> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      for (const candidate of this.sessions.values()) {
        if (jsonEqual(candidate.savedState()?.sessionFile, sessionPath) || (typeof sessionPath === 'string' && candidate.reservedPath() === sessionPath)) { session = candidate; break; }
      }
    }
    if (session) {
      if (archive) await this.releaseOwnedSession(session.identity, 'archive', session);
      else await session.retire();
    }
    return null;
  }

  private running(runtime: string): Session {
    const session = this.views.session(runtime);
    if (!session) throw new CommandRefusedError('Pi is not running', 'daemon');
    return session;
  }

  private async runtimeCommand(runtime: string, command: any): Promise<any> {
    if (command?.type === 'take_ownership') return this.takeOwnership(runtime);
    if (['pin_message', 'unpin_message'].includes(command?.type)) return this.pinCommand(runtime, command);
    const readonly = this.views.readonly(runtime);
    if (readonly) {
      if (['fork_after', 'copy_after'].includes(command?.type)) return forkFromView(this, runtime, readonly, structuredClone(command));
      return readonlyCommand(this, command, readonly);
    }
    const session = this.running(runtime);
    if (command?.type === 'reload_agents') return this.reloadAgents(runtime, text(command, 'sessionId'));
    return sessionCommand(this, session, runtime, structuredClone(command ?? null));
  }

  private pinCommand(runtime: string, command: any): null {
    const identity = this.views.readonly(runtime)?.id ?? this.views.session(runtime)?.identity;
    if (identity === undefined) throw new CommandRefusedError('Pi is not running', 'daemon');
    return this.pins.command(identity, command);
  }

  private async takeOwnership(runtime: string): Promise<any> {
    const current = this.views.request(runtime);
    if (current === undefined) throw new Error('This conversation has been deleted or closed');
    const target = structuredClone(current);
    if (flag(target.presence, 'readOnly')) throw new Error('This view is read-only');
    target.takeOwnership = true;
    const result = await attach(this, target);
    const session = this.views.session(runtime);
    if (flag(result, 'owned') && session) await this.attachLinkedViews(runtime, session.identity, text(target, 'clientId'));
    return result;
  }

  // Taking a chat also takes the other chats of its tree that the same client shows read-only.
  private async attachLinkedViews(taker: string, identity: string, client: string): Promise<void> {
    for (const member of this.ownership().chatTree(identity)) for (const runtime of this.views.readonlyRuntimes(member)) {
      const packet = this.views.request(runtime);
      if (runtime === taker || packet?.clientId !== client || flag(packet.presence, 'readOnly')) continue;
      try {
        const attached = await attach(this, { ...structuredClone(packet), takeOwnership: false });
        if (flag(attached, 'owned')) this.events.runtimeEvent(runtime, { type: 'ownership_acquired' });
      } catch (error) {
        this.events.diagnostic(member + ': could not take a chat of the same tree: ' + errorText(error));
        this.events.runtimeEvent(runtime, { type: 'disconnected' });
      }
    }
  }

  async detach(runtime: string, session: Session, discardBlank: boolean, preserveRunning: boolean): Promise<any> {
    this.views.unsubscribe(runtime);
    session.detachView(runtime);
    const result = await session.finishDetach(discardBlank, preserveRunning);
    await this.releaseUnused(session);
    return result;
  }
}
