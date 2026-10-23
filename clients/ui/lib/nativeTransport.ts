import { hostModelConnected } from "./modelReports";
import { DraftRuntime } from "./draftRuntime";
import { agentStateSchema, sessionGroupsSchema, voidResultSchema, storageReportSchema, rpcEventSchema, sessionSummarySchema, codexUsageSchema, opencodeGoUsageSchema, directoryListingSchema } from "./responseSchemas";
import { z } from "zod";
import { jsonResultSchema } from "./transportSchemas";
import { commandSessionSchema, runtimeEventSchema, runtimeStderrSchema, type CommandSession } from "./rpcSchemas";
import { discardSubmittedMessage, forgetSession, retainSessionResource } from "./sessionMemory";
import { PromptControls } from "./promptControls";
import { nativeCall as call } from "./nativeCall";
import { CommandRejectedError } from "./commandRejected";
import { NativeSettings } from "./nativeSettings";
import { locateConversation } from "./conversationLookup";
import { nativeTerminals } from "./nativeTerminals";
import { ConversationCommands } from "./conversationCommands";
import { listen, type UnlistenFn } from "./platform";
import { restoredSessionTarget, targetedWindowSession } from "./sessionResume";
import { recoverSessionDirectory } from "./sessionRecovery";
import { ConversationChangedError } from "./conversationChanged";
import type { GroupChange } from "./sessionGroups";
import type { AppSettings, RpcCommand, RpcEvent } from "../types";

export const openSessionWindow = (target: NativeConnectionTarget & { sessionId: string }) => call("new_window", { target }, z.string());

export function initialWindowTarget(): NativeConnectionTarget {
  try { const target = new URLSearchParams(window.location.search).get("target");

  return target ? targetedWindowSession(target) : restoredSessionTarget(); }
  catch { return {}; }
}

export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; readOnly?: boolean; draftKey?: string; }

export const loadSessionGroups = () => call("load_session_groups", { seeds: [] }, sessionGroupsSchema);

export const changeSessionGroups = (change: GroupChange) => call("change_session_groups", { change }, sessionGroupsSchema);

export const openGroupDirectory = (cwd: string, hostId: string) => call("open_project_directory", { cwd, hostId }, voidResultSchema);

export const openRolloutFile = (path: string, hostId: string) => call("open_rollout_file", { path, hostId }, voidResultSchema);

export const openExternalUrl = (url: string) => call("open_external_url", { url }, voidResultSchema);

export const loadStorageReport = async (hostId?: string) => {
  if (hostId === undefined) return call("storage_report", undefined, storageReportSchema);
  const report = await call("host_storage_report", { hostId }, storageReportSchema);

  return { hosts: report.hosts.map((host) => ({ ...host, hostId })) };
};


export const deleteArchivedConversations = (sessionPaths: string[], hostId = "local") => call("delete_archived_session", { sessionPath: sessionPaths[0], sessionPaths, hostId }, z.array(z.string()));

export const restoreArchivedConversation = (sessionPath: string, hostId = "local") => call("restore_archived_session", { sessionPath, hostId }, voidResultSchema);

export class NativeTransport {
  readonly promptControls = new PromptControls();
  private automaticBehavior = Promise.resolve();
  private automaticBehaviorGeneration = 0;
  private automaticRetry: boolean | undefined;

  configureAutomaticBehavior(autoRetry: boolean) {
    const generation = this.automaticBehaviorGeneration;

    const operation = this.automaticBehavior.then(async () => {
      if (generation !== this.automaticBehaviorGeneration || this.automaticRetry === autoRetry) return;
      await Promise.all([
        this.command({ type: "set_auto_compaction", enabled: true }),
        this.command({ type: "set_auto_retry", enabled: autoRetry }),
      ]);

      if (generation === this.automaticBehaviorGeneration) this.automaticRetry = autoRetry;
    });

    this.automaticBehavior = operation.catch(() => undefined);

    return operation;
  }

  async submitPrompt(command: RpcCommand) {
    if (this.promptControls.missingModel()) throw new Error("Choose a model before sending.");
    if (this.promptControls.hasPending()) await this.promptControls.flush(value => this.command(value), enabled => this.setFastMode(enabled));

    return this.command(command);
  }
  private owns = true;
  private archived = false;
  isArchived() { return this.archived; }
  ownsConversation() { return this.owns; }
  /** True while Pi runs for this view. A detached view has no Pi to read from. */
  isConnected() { return this.running; }
  hasConfirmedOwnership() { return this.running && this.owns; }
  async takeOwnership() {
    if (this.readOnly) throw new Error("This view is read-only");
    await this.command({ type: "take_ownership" });
    this.owns = true;
    this.emit({ type: "ownership_acquired" });
    this.emit({ type: "session_info_changed" });
    this.emit({ type: "settings_applied" });
  }
  private fresh = true;
  needsDefaults() { return this.fresh; }
  defaultsApplied() { this.fresh = false; }
  /** A draft shows the host's default agent. A started session already runs it, because the agents extension picks it when the session starts. */
  async applyNewChatDefaults(thinking: string, fastMode: boolean) {
    if (this.draftOnly()) await this.settings.runCommand(() => this.draftRuntime.applyDefaults(thinking, fastMode));
  }
  connectionTarget(): NativeConnectionTarget {
    const target: NativeConnectionTarget = { cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId };

    if (this.readOnly) target.readOnly = true;

    return target;
  }
  async restoreConnection(target: NativeConnectionTarget) {
    await this.disconnect();
    const hostId = target.hostId || "local";
    if (this.hostId !== hostId || this.sessionPath !== target.sessionPath || this.cwd !== target.cwd || (target.sessionId !== undefined && this.sessionId !== target.sessionId)) forgetSession(this);
    this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = hostId; this.daemonId = undefined;
    await this.connect();
  }
  async restoreRecoveryConnection(cwd: string, sessionPath: string, hostId = "local") {
    await this.restoreConnection({ cwd, sessionPath, hostId });
    this.emit({ type: "connection_restored" });
  }
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private queueSnapshot: RpcEvent = { type: "queue_update", steering: [], followUp: [], pendingMessages: [] };
  private visible = false;
  private presenceCleanup?: () => void;
  setVisible(visible: boolean) { this.visible = visible; this.publishPresence(); }
  private presence() {
    const presence = { visible: this.visible && document.visibilityState !== "hidden", focused: document.hasFocus() };

    return this.readOnly ? { ...presence, readOnly: true, archived: this.archived } : presence;
  }
  private publishPresence = () => { if (this.running) void call("pi_presence", { runtimeId: this.runtimeId, presence: this.presence() }).catch(() => undefined); };
  private listeners = new Set<(event: RpcEvent) => void>();
  private retainedStatuses = new Map<string, RpcEvent>();
  private retainedWidgets = new Map<string, RpcEvent>();
  private retainedRequests = new Map<string, RpcEvent>();
  private unlisten?: UnlistenFn;
  private stderrUnlisten?: UnlistenFn;
  private stderrLines: string[] = [];
  private connectionVersion = 0;
  private connectPromise?: Promise<void>;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disposal?: Promise<void>;
  private disposeListeners: Set<() => void> | undefined = new Set();
  private readonly settings = new NativeSettings(call, {
    target: () => ({ cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId }),
    selectTarget: target => { this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId; },
    resetToLocal: fresh => {
      this.hostId = "local"; this.cwd = undefined; this.sessionPath = undefined; this.sessionId = undefined;
      this.temporaryChat = false; this.temporaryChatUsed = false;

      if (fresh) this.fresh = true;
    },
    disconnect: () => this.disconnect(),
    connect: () => this.connect(),
    closed: () => this.disposed,
    emit: event => this.emit(event),
  });
  hasPendingSettings() { return this.settings.hasPending(); }
  queueSettings(settings: AppSettings, changes: { reconnect: boolean }) { this.settings.queue(settings, changes); }
  private cwd?: string;
  private sessionPath?: string;
  private sessionId?: string;
  private hostId = "local";
  private daemonId?: string;
  private running = false;
  private connectionAttempted = false;
  private readonly draftRuntime = new DraftRuntime(() => this.hostId, event => this.emit(event));
  private startingDraft?: Promise<void>;
  private draftTarget = false;
  private baseBranch?: string;
  private worktreeOptions?: { repository: string; branches: string[]; defaultBranch: string | null };
  setNewChatWorktreeOptions(options: { repository: string; branches: string[]; defaultBranch: string | null }) { this.worktreeOptions = options; }
  newChatWorktreeOptions() { return this.worktreeOptions; }
  newChatBaseBranch() { return this.baseBranch; }
  setNewChatBranch(branch?: string) { this.baseBranch = branch; }
  private initializingChat = false;
  private sentMessage = false;
  hasSentMessage() { return this.sentMessage; }
  private draftOnly() { return !this.initializingChat && !this.sessionPath && !this.sessionId && (this.draftTarget || this.cwd === undefined); }
  async startDraft() {
    if (this.startingDraft) return this.startingDraft;

    if (!this.draftOnly()) return;
    const pending = this.materializeDraft(); this.startingDraft = pending;

    try { await pending; } finally { if (this.startingDraft === pending) this.startingDraft = undefined; }
  }
  private async materializeDraft() {
    if (!await this.ensureConnectionDirectory(this.connectionVersion)) throw new Error("The draft was closed before sending");

    const project = this.temporaryChat ? undefined : this.cwd;
    this.initializingChat = true;

    try {
      await this.connect();
      await this.command({ type: "get_state" });

      for (const command of this.draftRuntime.changes.values()) await this.command(command);
      await this.setFastMode(this.draftRuntime.fastMode);
      this.emit({ type: "session_info_changed" });
    } catch (reason) {
      const path = this.cwd;
      await this.disconnect(true);

      if (path && !project) await call("remove_temporary_chat", { path, hostId: this.hostId }, voidResultSchema);
      this.cwd = project; this.sessionId = undefined; this.sessionPath = undefined; this.owns = true;
      throw reason;
    } finally { this.initializingChat = false; }
  }
  private temporaryChat = false;
  private temporaryChatUsed = false;
  private terminalActivity = false;
  private preparedTerminalIds = new Set<string>();
  hasTerminalActivity() { return this.terminalActivity; }
  isPreparedTerminal(terminalId: string) { return this.preparedTerminalIds.has(terminalId); }
  markTerminalActivity(cwd = this.cwd, hostId = this.hostId) {
    if (cwd && cwd === this.cwd && hostId === this.hostId) { this.terminalActivity = true; this.temporaryChatUsed = true; }
  }
  private readonly conversationCommands = new ConversationCommands();
  private readOnly: boolean;
  constructor(target: NativeConnectionTarget = {}) { this.draftTarget = Boolean(target.draftKey); this.sentMessage = Boolean(target.sessionId || target.sessionPath); this.readOnly = target.readOnly === true; this.fresh = !target.sessionPath && !target.sessionId; this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  currentHostId() { return this.hostId; }
  currentDaemonId() { return this.daemonId; }
  reloadAgentDefinitions(sessionId: string) {
    if (this.draftOnly()) {
      const version = this.connectionVersion;
      const hostId = this.hostId;

      return this.settings.runCommand(async () => {
        await this.draftRuntime.reload(() => this.draftOnly() && version === this.connectionVersion && hostId === this.hostId);
        // The reload can show a new default agent, so the composer's fallback model follows the draft. A model the user picked still wins.
        this.promptControls.useEffectiveModel(agentStateSchema.parse(await this.draftRuntime.command({ type: "get_state" })).model);
      });
    }
    const version = this.connectionVersion;
    const hostId = this.hostId;

    return this.settings.runCommand(async () => {
      if (!this.running || this.readOnly || version !== this.connectionVersion || hostId !== this.hostId) throw new Error("The session connection changed. Reload from its current host.");
      await this.applyAgentReload(sessionId);
    });
  }
  private async applyAgentReload(sessionId: string) {
    let revision = Infinity;
    let appliedRevision = -1;
    let failure: { agentRevision: number; error: string } | undefined;
    let listener: (event: RpcEvent) => void = () => undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          if (appliedRevision >= revision) resolve();
          else if (failure && failure.agentRevision >= revision) reject(new Error(failure.error));
        };

        listener = event => {
          if (this.sessionId !== sessionId || !this.running || ["disconnected", "ownership_lost"].includes(event.type)) {
            reject(new Error("The session connection changed before agent definitions finished reloading."));

            return;
          }

          const update = z.object({ agentRevision: z.number().int().nonnegative(), error: z.string().optional() }).safeParse(event);

          if (!update.success) return;

          if (event.type === "settings_applied") appliedRevision = Math.max(appliedRevision, update.data.agentRevision);

          if (event.type === "extension_error" && update.data.error) failure = { agentRevision: update.data.agentRevision, error: update.data.error };
          complete();
        };

        this.listeners.add(listener);
        void this.executeCommandNow({ type: "reload_agents", sessionId }, z.object({ success: z.literal(true), sessionId: z.literal(sessionId), agentRevision: z.number().int().nonnegative() })).then(result => {
          revision = result.agentRevision;
          complete();
        }).catch(reject);
      });
    } finally { this.listeners.delete(listener); }
  }
  currentCwd() { return this.cwd; }
  adoptBranchCwd(cwd: string) { this.cwd = cwd; }
  currentSessionPath() { return this.sessionPath; }
  isTemporaryChat() { return this.temporaryChat; }
  lastDiagnostic() { return this.stderrLines.join("\n"); }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined);

  return result; }
  private queueView(): RpcEvent { return this.queueSnapshot; }
  private trackSessionActivity(event: RpcEvent) {
    if (event.type === "agent_start" || (event.type === "message_start" && z.object({ role: z.literal("user") }).safeParse(event.message).success)) { this.temporaryChatUsed = true; this.sentMessage = true; }
  }
  private retainWidget(event: RpcEvent) {
    if (event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey !== undefined) {
      if (Array.isArray(event.widgetLines)) this.retainedWidgets.set(event.widgetKey, event); else this.retainedWidgets.delete(event.widgetKey);
    }
  }
  private retainExtensionState(event: RpcEvent) {
    this.retainWidget(event);

    if (event.type === "extension_ui_resolved" && event.id !== undefined) this.retainedRequests.delete(event.id);

    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey !== undefined) {
      if (event.statusText) this.retainedStatuses.set(event.statusKey, event); else this.retainedStatuses.delete(event.statusKey);
    }

    if (event.type === "extension_ui_request" && ["input", "editor", "select", "confirm"].includes(String(event.method)) && event.id !== undefined) this.retainedRequests.set(event.id, event);
  }
  private async ensureConnectionDirectory(version: number) {

    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await call("create_temporary_chat", { hostId: this.hostId }, z.object({ cwd: z.string(), sessionId: z.string() }));

    if (version !== this.connectionVersion) { await call("remove_temporary_chat", { path: chat.cwd, hostId: this.hostId }, voidResultSchema);

    return false; }

    this.cwd = chat.cwd; this.sessionId = chat.sessionId; this.temporaryChat = true; }

    return true;
  }
  private retainCommandSession(command: RpcCommand, result: CommandSession) {
    if (command.type === "get_state" || command.type === "get_snapshot") { const state = command.type === "get_snapshot" ? result.state ?? {} : result;

    this.retainSessionIdentity(state, command.type === "get_snapshot"); }

    if (command.type === "get_snapshot") {
      for (const event of result.extensionState ?? []) this.emit(event);
    }
  }
  private retainSessionIdentity(state: CommandSession, snapshot: boolean) {
    if (!state.sessionId) return;

    if (!snapshot && this.sessionId && this.sessionId !== state.sessionId) forgetSession(this);
    this.sessionPath = state.sessionFile; this.sessionId = state.sessionId;
  }
  private emit(event: RpcEvent) {
    if (event.type === "connection_restored") hostModelConnected(this.currentHostId());
    if (["disconnected", "connection_restored", "session_switched", "settings_applied", "ownership_lost"].includes(event.type)) {
      this.automaticRetry = undefined;
      this.automaticBehaviorGeneration += 1;
    }

    if (event.type === "ownership_lost") this.promptControls.reset();
    this.settings.receive(event);
    this.trackSessionActivity(event);
    this.retainExtensionState(event);

    if (event.type === "queue_update") this.queueSnapshot = event;

    if (["queue_update", "extension_ui_request", "extension_ui_resolved"].includes(event.type)) {
      retainSessionResource(this, "transport", [this.queueSnapshot, ...this.retainedStatuses.values(), ...this.retainedWidgets.values(), ...this.retainedRequests.values()], () => {
        this.queueSnapshot = { type: "queue_update", steering: [], followUp: [], pendingMessages: [] };
        this.retainedStatuses.clear(); this.retainedWidgets.clear(); this.retainedRequests.clear();
      });
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (reason) {
        queueMicrotask(() => { throw reason; });
      }
    }

    this.settings.afterEvent(event);
  }
  private connectionLost() {
    // Ownership stays as last known: losing the connection does not mean another client took the conversation.
    ++this.connectionVersion; this.connectPromise = undefined; this.running = false;
    this.retainedStatuses.clear(); this.retainedWidgets.clear(); this.retainedRequests.clear();
    this.presenceCleanup?.(); this.presenceCleanup = undefined;
  }
  private selectSessionPath(sessionPath: string) {
    if (sessionPath !== this.sessionPath) this.sessionId = undefined;
    this.sessionPath = sessionPath;
  }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string) {
    if (this.disposed) throw new Error("This conversation view has been closed");

    if (cwd !== undefined) this.cwd = cwd;

    if (sessionPath !== undefined) this.selectSessionPath(sessionPath);

    if (hostId !== undefined) this.hostId = hostId;

    if (this.running) return;

    if (!this.connectPromise && this.draftOnly() && !forkPath) { await this.draftRuntime.load(); this.temporaryChat = this.cwd === undefined; this.owns = !this.readOnly; hostModelConnected(this.currentHostId());

      return; }

    this.connectionAttempted = true;
    const pending = this.connectPromise ?? this.establishConnection(forkPath); this.connectPromise = pending;
    const version = this.connectionVersion;

    try {
      await pending;

      if (this.disposed || version !== this.connectionVersion) throw new ConversationChangedError();
    } finally { if (this.connectPromise === pending) this.connectPromise = undefined; }
  }
  private async resolveHomeDirectory(version: number) {
    if (this.cwd === "~" || this.cwd?.startsWith("~/")) {
      const home = await this.homeDirectory(this.hostId);

      if (version !== this.connectionVersion) return;
      this.cwd = this.cwd === "~" ? home : home.replace(/\/$/, "") + "/" + this.cwd.slice(2);
    }
  }
  private async resolveSavedTarget(version: number, forkPath?: string) {
    if (!this.sessionId || forkPath) return;

    if (!this.sessionPath && !this.readOnly) return;
    const location = await locateConversation(this.sessionId, this.hostId);

    if (version !== this.connectionVersion) return;

    if (location.archived && !this.readOnly) throw new Error("This conversation is archived. Restore it before continuing work");
    this.sessionPath = location.sessionPath;
    this.cwd = location.cwd;
    this.archived = location.archived;
  }
  private clearConnectionListeners() {
    this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.stderrLines = [];
  }
  private async establishConnection(forkPath?: string) {
    const version = ++this.connectionVersion;
    await this.resolveSavedTarget(version, forkPath);

    if (version !== this.connectionVersion) return;
    await this.resolveHomeDirectory(version);

    if (version !== this.connectionVersion) return;

    if (!await this.ensureConnectionDirectory(version)) return;
    this.clearConnectionListeners();

    const unlisten = await listen("pi://event", ({ payload }) => {
      const envelope = runtimeEventSchema.parse(payload);

      if (envelope.runtimeId !== undefined && envelope.runtimeId !== this.runtimeId) return;
      const event = envelope.event;

      if (envelope.runtimeId !== undefined && event.type === "ownership_lost") { this.owns = false; this.retainedRequests.clear(); }

      if (event.type === "disconnected") this.connectionLost();
      this.emit(event);
    }, z.union([rpcEventSchema, z.object({ runtimeId: z.string(), event: rpcEventSchema })]));

    const stderrUnlisten = await listen("pi://stderr", ({ payload }) => {
      const output = runtimeStderrSchema.parse(payload);
      const runtimeId = output.global ? this.runtimeId : output.runtimeId;
      const line = output.line;

      if (runtimeId !== this.runtimeId || !line?.trim()) return;
      this.stderrLines = [...this.stderrLines.slice(-4), line.trim()];
    }, z.union([z.object({ runtimeId: z.string().optional(), line: z.string().optional() }), z.string()])).catch(reason => {
      unlisten();
      throw reason;
    });

    if (version !== this.connectionVersion) { unlisten(); stderrUnlisten();

    return; }

    this.unlisten = unlisten; this.stderrUnlisten = stderrUnlisten;
    const attached = await this.runProcessCommand(() => version !== this.connectionVersion ? Promise.resolve(undefined) : call("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, baseBranch: !this.sessionId && !this.sessionPath ? this.baseBranch : undefined, sessionPath: !this.readOnly && this.sessionId ? undefined : this.sessionPath, sessionId: this.sessionId, forkPath, hostId: this.hostId, presence: this.presence() }, z.object({ attached: z.boolean(), owned: z.boolean().optional(), daemonId: z.string().optional(), cwd: z.string().nullable().optional() })));

    if (version !== this.connectionVersion || !attached) throw new Error("The conversation disconnected while starting. Reconnect to try again.");
    this.daemonId = attached.daemonId;
    if (attached.cwd) this.cwd = attached.cwd;

    if (version === this.connectionVersion) {
      this.running = true;
      hostModelConnected(this.currentHostId());
      this.connectedOwnership(attached);
      this.presenceCleanup?.();
      window.addEventListener("focus", this.publishPresence); window.addEventListener("blur", this.publishPresence); window.addEventListener("resize", this.publishPresence); document.addEventListener("visibilitychange", this.publishPresence);
      this.presenceCleanup = () => { window.removeEventListener("focus", this.publishPresence); window.removeEventListener("blur", this.publishPresence); window.removeEventListener("resize", this.publishPresence); document.removeEventListener("visibilitychange", this.publishPresence); };

      this.publishPresence();
    }
  }
  private connectedOwnership(attached: { attached: boolean; owned?: boolean } | undefined) {
    if (attached?.attached) this.fresh = false;
    const owns = !this.readOnly && attached?.owned !== false;

    if (this.initializingChat && owns === this.owns) return;
    this.owns = owns;
    this.emit({ type: this.owns ? "ownership_acquired" : "ownership_lost" });
  }
  async disconnect(discardBlank = false) { const owned = this.hasConfirmedOwnership(); ++this.connectionVersion; this.connectPromise = undefined; this.running = false; this.presenceCleanup?.(); this.presenceCleanup = undefined; this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.retainedStatuses.clear(); this.retainedWidgets.clear(); this.retainedRequests.clear();

    if (owned) this.emit({ type: "ownership_lost" });

  return this.runProcessCommand(() => call("stop_pi", { runtimeId: this.runtimeId, discardBlank }, z.boolean())); }
  onDispose(listener: () => void) {
    if (this.disposeListeners) this.disposeListeners.add(listener); else listener();

    return () => this.disposeListeners?.delete(listener);
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.settings.cancelPending();
    this.disposal = (async () => {
      await this.settings.whenApplied();
      const temporaryPath = this.temporaryChat && !this.temporaryChatUsed ? this.cwd : undefined;
      const temporaryHost = this.hostId;
      const stopped = await this.disconnect(true);

      if (temporaryPath && (stopped || !this.connectionAttempted)) await call("remove_temporary_chat", { path: temporaryPath, hostId: temporaryHost }, voidResultSchema);
      this.temporaryChat = false; this.temporaryChatUsed = false;
      const listeners = this.disposeListeners; this.disposeListeners = undefined;

      for (const listener of listeners ?? []) {
        try { listener(); } catch (reason) { queueMicrotask(() => { throw reason; }); }
      }
    })().catch(reason => { this.disposal = undefined; this.disposed = false; throw reason; });

    return this.disposal;
  }
  setDefaultFastMode(enabled: boolean) { this.draftRuntime.defaultFastMode = enabled; }
  async setFastMode(enabled: boolean) {
    if (this.draftOnly()) { this.draftRuntime.setFastMode(enabled);
      this.emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: enabled ? "Fast mode on" : "Fast mode off" });

      return; }

    await this.command({ type: "set_fast_mode", enabled });
  }
  command<S extends z.ZodType>(command: RpcCommand, schema: S): Promise<z.output<S>>;
  command(command: RpcCommand): Promise<z.output<typeof jsonResultSchema>>;
  async command(command: RpcCommand, schema: z.ZodType = jsonResultSchema) {
    const result = await this.executeCommand(command, schema);

    if (command.type === "select_agent" || command.type === "set_model") {
      const state = await this.executeCommand({ type: "get_state" }, agentStateSchema);
      this.promptControls.useEffectiveModel(state.model);
    }

    return result;
  }
  async changePendingMessage(id: string, action: import("../types").PendingMessageAction): Promise<void> {
    const pending = z.array(z.object({ id: z.string(), goalSubmissionId: z.string().optional() })).parse(this.queueSnapshot.pendingMessages ?? []).find(item => item.id === id);
    await this.executeCommand({ type: "change_pending", id, action }, voidResultSchema);

    if (action === "remove" && pending?.goalSubmissionId) discardSubmittedMessage(this, pending.goalSubmissionId);
  }
  private executeCommand<S extends z.ZodType>(command: RpcCommand, schema: S): Promise<z.output<S>> {
    return this.settings.runCommand(() => this.executeCommandNow(command, schema));
  }
  private async executeCommandNow<S extends z.ZodType>(command: RpcCommand, schema: S) {
    if (this.draftOnly()) return schema.parse(await this.draftRuntime.command(command));
    command = this.conversationCommands.normalize(command);

    try {
      const result = await call("pi_command", { runtimeId: this.runtimeId, command });
      this.retainCommandSession(command, commandSessionSchema.parse(result));
      this.resetChangedSession(command, z.object({ cancelled: z.boolean().optional() }).catch({}).parse(result));

      if (command.type === "extension_ui_response" && command.id !== undefined) this.retainedRequests.delete(command.id);

      return z.parse(schema, result);
    } catch (reason) {
      throw this.commandError(reason);
    }
  }
  private commandError(cause: unknown) {
    if (cause instanceof CommandRejectedError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const diagnostics = this.stderrLines.join("\n");

    return new Error(diagnostics && /disconnect|connect|start|running/i.test(message) ? `${message}\n${diagnostics}` : message);
  }
  private resetChangedSession(command: RpcCommand, result: { cancelled?: boolean }) {
    if (["new_session", "switch_session", "fork", "fork_after", "copy_after", "clone"].includes(command.type) && !result.cancelled) { forgetSession(this); this.sessionId = undefined; }
  }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); listener(this.queueView()); this.retainedStatuses.forEach((event) => listener(event)); this.retainedWidgets.forEach((event) => listener(event)); this.retainedRequests.forEach((event) => listener(event));

  return () => this.listeners.delete(listener); }
  listSessions() { return call("list_sessions", undefined, z.array(sessionSummarySchema)); }
  archiveSession(sessionPath: string, hostId = "local", terminalIds: string[] = []) { return call("archive_session", { sessionPath, hostId, terminalIds }, voidResultSchema); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return call("relocate_session", { sessionPath, cwd, hostId }, voidResultSchema); }
  recoverMissingSession(sessionPath: string, hostId = "local") { return recoverSessionDirectory(sessionPath, hostId); }
  openProjectDirectory(cwd: string, hostId = "local") { return call("open_project_directory", { cwd, hostId }, voidResultSchema); }
  loadSettings() { return this.settings.load(); }
  loadSettingsChange() { return this.settings.loadChange(); }
  loadHostSettings() { return this.settings.loadHost(); }
  loadHostSettingsChange() { return this.settings.loadHostChange(); }
  saveHostSettings(settings: AppSettings, agentsChanged = false) { return this.settings.saveHost(settings, agentsChanged); }
  loadCodexUsage() { return call("codex_usage", undefined, codexUsageSchema); }
  loadOpencodeGoUsage() { return call("opencode_go_usage", undefined, opencodeGoUsageSchema); }
  saveSettings(settings: AppSettings, reconnect = true, agentHostId?: string, scope: "all" | "client" | "daemon" = "all", baseline?: AppSettings) {
    return this.settings.save(settings, reconnect, agentHostId, scope, baseline);
  }
  homeDirectory(hostId: string) { return call("home_directory", { hostId }, z.string()); }
  newChatBranches(path: string, hostId: string) { return call("new_chat_branches", { path, hostId }, z.object({ repository: z.string(), branches: z.array(z.string()), defaultBranch: z.string().nullable() }).nullable()); }
  validateProjectDirectory(path: string, hostId: string, allowStorage = false, newChat = false) { return call("validate_project_directory", { path, hostId, allowStorage, newChat }, z.string()); }
  listDirectories(hostId: string, path?: string) { return call("list_directories", { hostId, path }, directoryListingSchema); }
  async prepareTemporaryChat(hostId: string) { this.cwd = undefined; this.sessionPath = undefined; this.sessionId = undefined; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false;

    return undefined; }
  startTerminal(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId = this.hostId, preparation = false) {
    if (!this.sentMessage) return Promise.reject(new Error("Send the first message before opening a terminal"));

    if (preparation) this.preparedTerminalIds.add(terminalId);
    else this.markTerminalActivity(cwd, hostId);

    return nativeTerminals.start(terminalId, sessionKey, cwd, cols, rows, hostId);
  }
  writeTerminal(terminalId: string, data: string) { return nativeTerminals.write(terminalId, data); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return nativeTerminals.resize(terminalId, cols, rows); }
  reassignTerminal(terminalId: string, sessionKey: string) { return nativeTerminals.reassign(terminalId, sessionKey); }
  closeTerminal(terminalId: string) { return nativeTerminals.close(terminalId); }
}

export async function readDroppedFile(path: string): Promise<File> {
  const result = await call("read_dropped_file", { path }, z.object({ name: z.string(), data: z.array(z.number()) }));
  const extension = result.name.split(".").pop()?.toLowerCase() ?? "";
  const imageTypes = new Map(Object.entries({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }));

  return new File([new Uint8Array(result.data)], result.name, { type: imageTypes.get(extension) ?? "" });
}
