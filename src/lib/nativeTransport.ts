import { sessionGroupsSchema, voidResultSchema, projectBranchesSchema, storageReportSchema, gitWorktreeSchema, gitWorktreeRemovalSchema, rpcEventSchema, sessionSummarySchema, gitDiffSnapshotSchema, gitDiffSnapshotsSchema, codexUsageSchema, opencodeGoUsageSchema, directoryListingSchema } from "./responseSchemas";
import { z } from "zod";
import { jsonResultSchema } from "./transportSchemas";
import { commandSessionSchema, runtimeEventSchema, runtimeStderrSchema, type CommandSession } from "./rpcSchemas";
import { forgetSession, retainSessionResource } from "./sessionMemory";
import { PromptControls } from "./promptControls";
import { nativeCall as call } from "./nativeCall";
import { NativeSettings } from "./nativeSettings";
import { nativeTerminals } from "./nativeTerminals";
import { ConversationCommands } from "./conversationCommands";
import { commandListingSchema } from "./fastModeCommands";
import { listen, type UnlistenFn } from "./platform";
import { open } from "@tauri-apps/plugin-dialog";
import { nativeConnectionTargetSchema, restoredSessionTarget } from "./sessionResume";
import type { GroupChange, SessionGroup, SessionGroups, SessionGroupSeed } from "./sessionGroups";
import type { AppSettings, GitDiffSnapshots, RpcCommand, RpcEvent, StorageReport } from "../types";

export const openSessionWindow = (target: NativeConnectionTarget & { sessionId: string }) => call("new_window", { target }, z.string());

export function initialWindowTarget(): NativeConnectionTarget {
  try { const target = new URLSearchParams(window.location.search).get("target"); const value = target ? JSON.parse(target) : restoredSessionTarget();

  return nativeConnectionTargetSchema.parse(value); }
  catch { return {}; }
}

export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; readOnly?: boolean; draftKey?: string; }

export const loadSessionGroups = (seeds: SessionGroupSeed[], legacy: SessionGroups) => call("load_session_groups", { seeds, legacy }, sessionGroupsSchema);

export const changeSessionGroups = (change: GroupChange) => call("change_session_groups", { change }, sessionGroupsSchema);

export const openGroupDirectory = (cwd: string, hostId: string) => call("open_project_directory", { cwd, hostId }, voidResultSchema);

export const openRolloutFile = (path: string, hostId: string) => call("open_rollout_file", { path, hostId }, voidResultSchema);

export const gitProjectKind = (cwd: string, hostId: string) => call("git_project_kind", { cwd, hostId }, z.union([z.literal("no-repo"), z.literal("main"), z.literal("worktree")]));

export interface ProjectBranches { branches: string[]; current: string | null; path: string; mainPath: string; }

export const projectBranches = (cwd: string, hostId: string, branch?: string) => call("project_branches", { cwd, hostId, branch }, z.union([projectBranchesSchema, z.null()]));

export async function resolveBranchGroup(group: SessionGroup) {
  if (!group.branch || !group.cwd) return group;
  const selected = await projectBranches(group.cwd, group.hostId ?? "local", group.branch);

  if (!selected) throw new Error("Project is not a Git repository");

  return { ...group, cwd: selected.path };
}

export const gitWorktreeRoots = (paths: string[], hostId: string) => call("git_worktree_roots", { paths, hostId }, z.array(z.union([z.string(), z.null()])));

export interface GitWorktree { branch: string; path: string; }

export interface GitWorktreeRemoval { branch?: string; branchDeleted: boolean; warning?: string; }

export const openExternalUrl = (url: string) => call("open_external_url", { url }, voidResultSchema);

export const loadStorageReport = async (hostId?: string) => {
  if (hostId === undefined) return call("storage_report", undefined, storageReportSchema);
  let report: StorageReport;

  try { report = await call("host_storage_report", { hostId }, storageReportSchema); }
  catch (reason) {
    if (!String(reason).includes("Command is not available on the daemon: host_storage_report")) throw reason;
    const legacy = await call("storage_report", undefined, storageReportSchema);
    const hosts = legacy.hosts.filter((host) => host.hostId === hostId);

    if (!hosts.length) throw new Error("This daemon did not return storage information for the selected machine. Update its Piop daemon and retry.");

    return { hosts };
  }

  return hostId === undefined ? report : { hosts: report.hosts.map((host) => ({ ...host, hostId })) };
};

export const deleteArchivedConversation = (sessionPath: string, hostId = "local") => call("delete_archived_session", { sessionPath, hostId }, z.array(z.string()));

export const deleteArchivedConversations = (sessionPaths: string[], hostId = "local") => call("delete_archived_session", { sessionPath: sessionPaths[0], sessionPaths, hostId }, z.array(z.string()));

export const restoreArchivedConversation = (sessionPath: string, hostId = "local") => call("restore_archived_session", { sessionPath, hostId }, voidResultSchema);

export const restoreArchivedWorktree = (sessionPath: string, hostId = "local") => call("restore_archived_worktree", { sessionPath, hostId }, gitWorktreeSchema.extend({ branch: z.string().nullable() }));

export const removeArchivedWorktree = (cwd: string, hostId = "local") => call("remove_git_worktree", { cwd, hostId, deleteBranch: false }, gitWorktreeRemovalSchema);

export class NativeTransport {
  readonly promptControls = new PromptControls();
  async submitPrompt(command: RpcCommand) {
    await this.promptControls.flush(value => this.command(value), enabled => this.setFastMode(enabled));

    return this.command(command);
  }
  private owns = true;
  ownsConversation() { return this.owns; }
  hasConfirmedOwnership() { return this.running && this.owns; }
  async takeOwnership() {
    if (this.readOnly) throw new Error("This view is read-only");
    await this.command({ type: "take_ownership" });
    this.owns = true;
    this.emit({ type: "ownership_acquired" });
    this.emit({ type: "session_info_changed" });
    this.emit({ type: "settings_applied" });
  }
  private ephemeral = false;
  isEphemeral() { return this.ephemeral; }
  private fresh = true;
  needsDefaults() { return this.fresh; }
  defaultsApplied() { this.fresh = false; }
  connectionTarget(): NativeConnectionTarget {
    const target: NativeConnectionTarget = { cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId };

    if (this.readOnly) target.readOnly = true;

    return target;
  }
  async restoreConnection(target: NativeConnectionTarget) { await this.disconnect(); this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId || "local"; this.daemonId = undefined; await this.connect(); }
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private queueSnapshot: RpcEvent = { type: "queue_update", steering: [], followUp: [], pendingMessages: [] };
  private visible = false;
  private presenceCleanup?: () => void;
  setVisible(visible: boolean) { this.visible = visible; this.publishPresence(); }
  private presence() {
    const presence = { visible: this.visible && document.visibilityState !== "hidden", focused: document.hasFocus(), screenWidth: window.screen?.width ?? 0 };

    return this.readOnly ? { ...presence, readOnly: true } : presence;
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
  private temporaryChat = false;
  private temporaryChatUsed = false;
  private terminalActivity = false;
  private preparedTerminalIds = new Set<string>();
  hasTerminalActivity() { return this.terminalActivity; }
  isPreparedTerminal(terminalId: string) { return this.preparedTerminalIds.has(terminalId); }
  markTerminalActivity(cwd = this.cwd, hostId = this.hostId) {
    if (cwd && cwd === this.cwd && hostId === this.hostId) { this.terminalActivity = true; this.temporaryChatUsed = true; }
  }
  private readonly fastMode = new ConversationCommands({
    command: async command => { await this.command(command); },
    send: async command => { await call("pi_command", { runtimeId: this.runtimeId, command }); },
    emit: event => this.emit(event),
  });
  private readOnly: boolean;
  constructor(target: NativeConnectionTarget = {}) { this.readOnly = target.readOnly === true; this.fresh = !target.sessionPath && !target.sessionId; this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  currentHostId() { return this.hostId; }
  currentDaemonId() { return this.daemonId; }
  reloadAgentDefinitions(sessionId: string) {
    const version = this.connectionVersion;
    const hostId = this.hostId;

    return this.settings.runCommand(async () => {
      if (!this.running || this.readOnly || version !== this.connectionVersion || hostId !== this.hostId) throw new Error("The session connection changed. Reload from its current host.");
      await this.executeCommandNow({ type: "reload_agents", sessionId }, z.object({ success: z.literal(true), sessionId: z.literal(sessionId) }));
    });
  }
  currentCwd() { return this.cwd; }
  currentSessionPath() { return this.sessionPath; }
  isTemporaryChat() { return this.temporaryChat; }
  lastDiagnostic() { return this.stderrLines.join("\n"); }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined);

  return result; }
  private queueView(): RpcEvent { return this.queueSnapshot; }
  private trackSessionActivity(event: RpcEvent) {
    if (event.type === "agent_start" || (event.type === "message_start" && z.object({ role: z.literal("user") }).safeParse(event.message).success)) this.temporaryChatUsed = true;
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
    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await call("create_temporary_chat", { hostId: this.hostId, e2e: import.meta.env.MODE === "e2e" }, z.object({ cwd: z.string(), sessionId: z.string() }));

    if (version !== this.connectionVersion) { await call("remove_temporary_chat", { path: chat.cwd, hostId: this.hostId }, voidResultSchema);

    return false; }

    this.cwd = chat.cwd; this.sessionId = chat.sessionId; this.temporaryChat = true; }

    return true;
  }
  private retainCommandSession(command: RpcCommand, result: CommandSession) {
    if (command.type === "get_state" || command.type === "get_snapshot") { const state = command.type === "get_snapshot" ? result.state ?? {} : result;

    if (this.sessionId && this.sessionId !== state.sessionId) forgetSession(this); this.sessionPath = state.sessionFile; this.sessionId = state.sessionId; }

    if (command.type === "get_snapshot") {
      for (const event of result.extensionState ?? []) this.emit(event);
    }
  }
  private emit(event: RpcEvent) {
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
    ++this.connectionVersion; this.connectPromise = undefined; this.running = false; this.owns = false;
    this.retainedStatuses.clear(); this.retainedWidgets.clear(); this.retainedRequests.clear();
    this.presenceCleanup?.(); this.presenceCleanup = undefined;
  }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string, ephemeral = false, forkLeafId?: string) {
    if (this.disposed) throw new Error("This conversation view has been closed");
    this.ephemeral ||= ephemeral;

    if (cwd !== undefined) this.cwd = cwd;

    if (sessionPath !== undefined) { this.sessionPath = sessionPath; this.sessionId = undefined; }

    if (hostId !== undefined) this.hostId = hostId;

    if (this.running) return;

    if (this.connectPromise) return this.connectPromise;
    this.connectionAttempted = true;
    const pending = this.establishConnection(forkPath, ephemeral, forkLeafId); this.connectPromise = pending;

    try { await pending; } finally { if (this.connectPromise === pending) this.connectPromise = undefined; }
  }
  private async resolveHomeDirectory(version: number) {
    if (this.cwd === "~" || this.cwd?.startsWith("~/")) {
      const home = await this.homeDirectory(this.hostId);

      if (version !== this.connectionVersion) return;
      this.cwd = this.cwd === "~" ? home : home.replace(/\/$/, "") + "/" + this.cwd.slice(2);
    }
  }
  private clearConnectionListeners() {
    this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.stderrLines = [];
  }
  private async establishConnection(forkPath?: string, _ephemeral = false, forkLeafId?: string) {
    const version = ++this.connectionVersion;
    await this.resolveHomeDirectory(version);

    if (version !== this.connectionVersion) return;

    if (!await this.ensureConnectionDirectory(version)) return;
    this.fastMode.reset();
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
    }, z.union([z.object({ runtimeId: z.string().optional(), line: z.string().optional() }), z.string()]));

    if (version !== this.connectionVersion) { unlisten(); stderrUnlisten();

    return; }

    this.unlisten = unlisten; this.stderrUnlisten = stderrUnlisten;
    const attached = await this.runProcessCommand(() => version !== this.connectionVersion ? Promise.resolve(undefined) : call("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, sessionPath: !this.readOnly && this.sessionId ? undefined : this.sessionPath, sessionId: this.sessionId, forkPath, forkLeafId, noSession: this.ephemeral, hostId: this.hostId, presence: this.presence() }, z.object({ attached: z.boolean(), owned: z.boolean().optional(), daemonId: z.string().optional() })));

    if (version !== this.connectionVersion || !attached) throw new Error("The conversation disconnected while starting. Reconnect to try again.");
    this.daemonId = attached.daemonId;

    if (version === this.connectionVersion) {
      this.running = true;
      this.connectedOwnership(attached);
      this.presenceCleanup?.();
      window.addEventListener("focus", this.publishPresence); window.addEventListener("blur", this.publishPresence); window.addEventListener("resize", this.publishPresence); document.addEventListener("visibilitychange", this.publishPresence);
      this.presenceCleanup = () => { window.removeEventListener("focus", this.publishPresence); window.removeEventListener("blur", this.publishPresence); window.removeEventListener("resize", this.publishPresence); document.removeEventListener("visibilitychange", this.publishPresence); };

      this.publishPresence();
    }
  }
  private connectedOwnership(attached: { attached: boolean; owned?: boolean } | undefined) {
    if (attached?.attached) this.fresh = false;
    this.owns = !this.readOnly && attached?.owned !== false;
    this.emit({ type: this.owns ? "ownership_acquired" : "ownership_lost" });
  }
  async disconnect(discardBlank = false) { const owned = this.hasConfirmedOwnership(); ++this.connectionVersion; this.running = false; this.owns = false; this.presenceCleanup?.(); this.presenceCleanup = undefined; this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.retainedStatuses.clear(); this.retainedWidgets.clear(); this.retainedRequests.clear();

    if (owned) this.emit({ type: "ownership_lost" });

  return this.runProcessCommand(() => call("stop_pi", { runtimeId: this.runtimeId, discardBlank }, z.boolean())); }
  reconnectForSettings(settings: AppSettings) { return this.settings.reconnect(settings); }
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
    })().catch(reason => { this.disposal = undefined; this.disposed = false; throw reason; });

    return this.disposal;
  }
  toggleFastMode() { return this.fastMode.toggle(); }
  setFastMode(enabled: boolean) { return this.fastMode.set(enabled); }
  command<S extends z.ZodType>(command: RpcCommand, schema: S): Promise<z.output<S>>;
  command(command: RpcCommand): Promise<z.output<typeof jsonResultSchema>>;
  command(command: RpcCommand, schema: z.ZodType = jsonResultSchema) { return this.executeCommand(command, schema); }
  changePendingMessage(id: string, action: import("../types").PendingMessageAction): Promise<void> {
    return this.executeCommand({ type: "change_pending", id, action }, voidResultSchema);
  }
  private executeCommand<S extends z.ZodType>(command: RpcCommand, schema: S): Promise<z.output<S>> {
    return this.settings.runCommand(() => this.executeCommandNow(command, schema));
  }
  private async executeCommandNow<S extends z.ZodType>(command: RpcCommand, schema: S) {
    command = this.fastMode.normalize(command);

    try {
      const result = await call("pi_command", { runtimeId: this.runtimeId, command: { ...command, clientScreenWidth: window.screen?.width ?? 0 } });
      this.retainCommandSession(command, commandSessionSchema.parse(result));
      this.resetChangedSession(command, z.object({ cancelled: z.boolean().optional() }).catch({}).parse(result));
      const fastModeUpdate = this.fastMode.afterCommand(command, command.type === "get_commands" ? commandListingSchema.parse(result) : undefined);

      if (fastModeUpdate) await fastModeUpdate;

      if (command.type === "extension_ui_response" && command.id !== undefined) this.retainedRequests.delete(command.id);

      return z.parse(schema, result);
    } catch (reason) {
      throw this.commandError(reason);
    }
  }
  private commandError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const diagnostics = this.stderrLines.join("\n");

    return new Error(diagnostics && /disconnect|connect|start|running/i.test(message) ? `${message}\n${diagnostics}` : message);
  }
  private resetChangedSession(command: RpcCommand, result: { cancelled?: boolean }) {
    if (["new_session", "switch_session", "fork", "fork_after", "clone"].includes(command.type) && !result.cancelled) { forgetSession(this); this.sessionId = undefined; }
  }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); listener(this.queueView()); this.retainedStatuses.forEach((event) => listener(event)); this.retainedWidgets.forEach((event) => listener(event)); this.retainedRequests.forEach((event) => listener(event));

  return () => this.listeners.delete(listener); }
  listSessions() { return call("list_sessions", undefined, z.array(sessionSummarySchema)); }
  captureGitTree(cwd: string, hostId = "local") { return call("capture_git_tree", { cwd, hostId }, z.union([z.string(), z.null()])); }
  discardGitTree(snapshot: string, hostId = "local") { return call("discard_git_tree", { snapshot, hostId }, voidResultSchema); }
  loadGitDiff(cwd: string, baseTree: string, hostId = "local") { return call("load_git_diff", { cwd, baseTree, hostId }, z.union([gitDiffSnapshotSchema, z.null()])); }
  loadGitDiffs(sessionPath: string, hostId = "local") { return call("load_git_diffs", { sessionPath, hostId }, gitDiffSnapshotsSchema); }
  saveGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId = "local") { return call("save_git_diffs", { sessionPath, snapshots, hostId }, voidResultSchema); }
  archiveSession(sessionPath: string, hostId = "local", terminalIds: string[] = []) { return call("archive_session", { sessionPath, hostId, terminalIds }, voidResultSchema); }
  deleteSession(sessionPath: string, hostId = "local") { return call("delete_session", { sessionPath, hostId }, z.array(z.string())); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return call("relocate_session", { sessionPath, cwd, hostId }, voidResultSchema); }
  inspectMissingSession(sessionPath: string, hostId = "local") { return call("recover_missing_session", { sessionPath, hostId, action: "inspect" }, z.object({ canRecoverRemote: z.boolean() })); }
  recoverMissingSession(sessionPath: string, action: "remote" | "empty", repository: string, branch: string, hostId = "local") { return call("recover_missing_session", { sessionPath, hostId, action, repository, branch }, z.union([z.object({ cwd: z.string() }), z.object({ missingFields: z.array(z.string()) })])); }
  async relocateDirlessSession(sessionPath: string, hostId = "local") {
    const chat = await call("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }, z.object({ cwd: z.string() }));
    await this.relocateSession(sessionPath, chat.cwd, hostId);
  }
  openProjectDirectory(cwd: string, hostId = "local") { return call("open_project_directory", { cwd, hostId }, voidResultSchema); }
  createProjectWorktree(cwd: string, name: string, hostId = "local") { return call("create_project_worktree", { cwd, name, hostId }, gitWorktreeSchema); }
  createGitWorktree(cwd: string, name: string, hostId = "local") { return call("create_git_worktree", { cwd, name, hostId }, gitWorktreeSchema); }
  removeGitWorktree(cwd: string, hostId = "local", deleteBranch = false) { return call("remove_git_worktree", { cwd, hostId, deleteBranch }, gitWorktreeRemovalSchema); }
  async runWorktreeSetup(cwd: string, worktreePath: string, hostId = "local", onSetup?: (cancel: (() => Promise<void>) | undefined) => void) {
    const setupId = await call("prepare_worktree_setup", { hostId }, z.string());
    onSetup?.(() => call("cancel_worktree_setup", { setupId }, voidResultSchema));

    try { await call("run_worktree_setup", { setupId, cwd, worktreePath, hostId }, voidResultSchema); }
    finally { onSetup?.(undefined); }
  }
  async isGitRepository() { if (!this.cwd) return false;

  return call("is_git_repository", { cwd: this.cwd, hostId: this.hostId }, z.boolean()); }
  async gitBranch() { if (!this.cwd) return null; const branch = await call("git_branch", { cwd: this.cwd, hostId: this.hostId });

  return z.string().nullable().catch(null).parse(branch); }
  loadSettings() { return this.settings.load(); }
  loadHostSettings() { return this.settings.loadHost(); }
  saveHostSettings(settings: AppSettings, agentsChanged = false) { return this.settings.saveHost(settings, agentsChanged); }
  loadCodexUsage() { return call("codex_usage", undefined, codexUsageSchema); }
  loadOpencodeGoUsage() { return call("opencode_go_usage", undefined, opencodeGoUsageSchema); }
  saveSettings(settings: AppSettings, reconnect = true, agentHostId?: string, scope: "all" | "client" = "all") {
    return this.settings.save(settings, reconnect, agentHostId, scope);
  }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath });

  return Array.isArray(selected) ? null : selected; }
  homeDirectory(hostId: string) { return call("home_directory", { hostId }, z.string()); }
  validateProjectDirectory(path: string, hostId: string, allowStorage = false) { return call("validate_project_directory", { path, hostId, allowStorage }, z.string()); }
  listDirectories(hostId: string, path?: string) { return call("list_directories", { hostId, path }, directoryListingSchema); }
  async prepareTemporaryChat(hostId: string) { const chat = await call("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }, z.object({ cwd: z.string(), sessionId: z.string() })); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false;

  return chat.cwd; }
  startTerminal(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId = this.hostId, preparation = false) {
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
