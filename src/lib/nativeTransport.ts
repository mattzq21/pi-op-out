import { forgetSession, retainSessionResource } from "./sessionMemory";
import { ConversationCommands } from "./conversationCommands";
import { TransportSettings, type SettingsConnectionTarget } from "./transportSettings";
import { invoke, listen, type UnlistenFn } from "./platform";
import { open } from "@tauri-apps/plugin-dialog";
import { emit as emitNativeEvent } from "@tauri-apps/api/event";
import type { GroupChange, SessionGroups, SessionGroupSeed } from "./sessionGroups";
import type { AppSettings, CodexUsage, DirectoryListing, GitDiffSnapshot, GitDiffSnapshots, OpencodeGoUsage, RpcCommand, RpcEvent, SessionSummary, StorageReport } from "../types";

function responseKey(command: string, args?: Record<string, unknown>) {
  return command === "pi_command" ? `${command}:${String((args?.command as RpcCommand)?.type)}` : command;
}

const terminalWrites = new Map<string, Promise<void>>();
const terminalStarts = new Map<string, Promise<void>>();

function mockResponse<T>(command: string, response: { error?: string; events?: RpcEvent[] }, args?: Record<string, unknown>) {
  if (response?.error) return Promise.reject(new Error(response.error));
  if (command === "start_pi" && Array.isArray(response?.events)) {
    return Promise.all(response.events.map((event: RpcEvent) => emitNativeEvent("pi://event", { runtimeId: args?.runtimeId, event })))
      .then(() => new Promise<T>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(response as T)))));
  }
  return Promise.resolve(response as T);
}

const call = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.MODE !== "e2e") return invoke<T>(command, args);
  const key = responseKey(command, args);
  const responseField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-responses"); const callField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls");
  const responses = JSON.parse(responseField?.value || "{}");
  if (callField?.value) { const calls = JSON.parse(callField.value); calls.push({ command, args, mocked: key in responses }); callField.value = JSON.stringify(calls); }
  if (!(key in responses)) return invoke<T>(command, args);
  return mockResponse<T>(command, responses[key], args);
};

export const openSessionWindow = (target: NativeConnectionTarget & { sessionId: string }) => call<string>("new_window", { target });
export function initialWindowTarget(): NativeConnectionTarget {
  try { const value = JSON.parse(new URLSearchParams(window.location.search).get("target") || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; readOnly?: boolean; }
export const loadSessionGroups = (seeds: SessionGroupSeed[], legacy: SessionGroups) => call<SessionGroups>("load_session_groups", { seeds, legacy });
export const changeSessionGroups = (change: GroupChange) => call<SessionGroups>("change_session_groups", { change });
export const openGroupDirectory = (cwd: string, hostId: string) => call<void>("open_project_directory", { cwd, hostId });
export const gitProjectKind = (cwd: string, hostId: string) => call<"no-repo" | "main" | "worktree">("git_project_kind", { cwd, hostId });
export const gitWorktreeRoots = (paths: string[], hostId: string) => call<Array<string | null>>("git_worktree_roots", { paths, hostId });
export interface GitWorktree { branch: string; path: string; }
export interface GitWorktreeRemoval { branch?: string; branchDeleted: boolean; warning?: string; }

export const openExternalUrl = (url: string) => call<void>("open_external_url", { url });
export const loadStorageReport = async (hostId?: string) => {
  if (hostId === undefined) return call<StorageReport>("storage_report");
  let report: StorageReport;
  try { report = await call<StorageReport>("host_storage_report", { hostId }); }
  catch (reason) {
    if (!String(reason).includes("Command is not available on the daemon: host_storage_report")) throw reason;
    const legacy = await call<StorageReport>("storage_report");
    const hosts = legacy.hosts.filter((host) => host.hostId === hostId);
    if (!hosts.length) throw new Error("This daemon did not return storage information for the selected machine. Update its Piop daemon and retry.");
    return { hosts };
  }
  return hostId === undefined ? report : { hosts: report.hosts.map((host) => ({ ...host, hostId })) };
};
export const deleteArchivedConversation = (sessionPath: string, hostId = "local") => call<void>("delete_archived_session", { sessionPath, hostId });
export const restoreArchivedWorktree = (sessionPath: string, hostId = "local") => call<GitWorktree>("restore_archived_worktree", { sessionPath, hostId });
export const removeArchivedWorktree = (cwd: string, hostId = "local") => call<GitWorktreeRemoval>("remove_git_worktree", { cwd, hostId, deleteBranch: false });

export class NativeTransport {
  private owns = true;
  ownsConversation() { return this.owns; }
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
  connectionTarget(): NativeConnectionTarget { return { cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId, ...(this.readOnly ? { readOnly: true } : {}) }; }
  async restoreConnection(target: NativeConnectionTarget) { await this.disconnect(); this.selectConnectionTarget({ ...target, hostId: target.hostId || "local" }); this.daemonId = undefined; await this.connect(); }
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private queueSnapshot: RpcEvent = { type: "queue_update", steering: [], followUp: [], pendingMessages: [] };
  private visible = false;
  private presenceCleanup?: () => void;
  setVisible(visible: boolean) { this.visible = visible; this.publishPresence(); }
  private presence() { return { visible: this.visible && document.visibilityState !== "hidden", focused: document.hasFocus(), ...(this.readOnly ? { readOnly: true } : {}) }; }
  private publishPresence = () => { if (this.running) void call("pi_presence", { runtimeId: this.runtimeId, presence: this.presence() }).catch(() => undefined); };
  private listeners = new Set<(event: RpcEvent) => void>();
  private retainedStatuses = new Map<string, RpcEvent>();
  private retainedRequests = new Map<string, RpcEvent>();
  private unlisten?: UnlistenFn;
  private stderrUnlisten?: UnlistenFn;
  private stderrLines: string[] = [];
  private connectionVersion = 0;
  private connectPromise?: Promise<void>;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private disposed = false;
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
  hasTerminalActivity() { return this.terminalActivity; }
  private readOnly: boolean;
  private readonly settings = new TransportSettings({
    invoke: call,
    connection: {
      target: () => ({ cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId }),
      select: target => this.selectConnectionTarget(target),
      resetToLocal: resetDefaults => this.resetConversation("local", resetDefaults),
      disconnect: () => this.disconnect(),
      connect: () => this.connect(),
    },
    emit: event => this.emit(event),
  });
  private readonly conversationCommands = new ConversationCommands({
    send: <T>(command: RpcCommand) => this.sendCommand<T>(command),
    command: <T>(command: RpcCommand) => this.command<T>(command),
    emit: event => this.emit(event),
  });
  constructor(target: NativeConnectionTarget = {}) { this.readOnly = target.readOnly === true; this.fresh = !target.sessionPath && !target.sessionId; this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  private selectConnectionTarget(target: SettingsConnectionTarget) {
    this.cwd = target.cwd;
    this.sessionPath = target.sessionPath;
    this.sessionId = target.sessionId;
    this.hostId = target.hostId;
  }
  private resetConversation(hostId: string, resetDefaults: boolean) {
    this.selectConnectionTarget({ hostId });
    this.temporaryChat = false;
    this.temporaryChatUsed = false;
    if (resetDefaults) this.fresh = true;
  }
  currentHostId() { return this.hostId; }
  currentDaemonId() { return this.daemonId; }
  currentCwd() { return this.cwd; }
  currentSessionPath() { return this.sessionPath; }
  isTemporaryChat() { return this.temporaryChat; }
  lastDiagnostic() { return this.stderrLines.join("\n"); }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  private queueView(): RpcEvent { return this.queueSnapshot; }
  private trackSessionActivity(event: RpcEvent) {
    if (event.type === "agent_start" || (event.type === "message_start" && (event.message as { role?: string })?.role === "user")) this.temporaryChatUsed = true;
  }
  private retainExtensionState(event: RpcEvent) {
    if (event.type === "extension_ui_resolved" && typeof event.id === "string") this.retainedRequests.delete(event.id);
    if (event.type === "extension_ui_request" && event.method === "setStatus" && typeof event.statusKey === "string") {
      if (event.statusText) this.retainedStatuses.set(event.statusKey, event); else this.retainedStatuses.delete(event.statusKey);
    }
    if (event.type === "extension_ui_request" && ["input", "editor", "select", "confirm"].includes(String(event.method)) && typeof event.id === "string") this.retainedRequests.set(event.id, event);
  }
  private async ensureConnectionDirectory(version: number) {
    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId: this.hostId, e2e: import.meta.env.MODE === "e2e" }); if (version !== this.connectionVersion) { await call<void>("remove_temporary_chat", { path: chat.cwd, hostId: this.hostId }); return false; } this.cwd = chat.cwd; this.sessionId = chat.sessionId; this.temporaryChat = true; }
    return true;
  }
  private retainCommandSession(command: RpcCommand, result: unknown) {
    if (command.type === "get_state" || command.type === "get_snapshot") { const state = (command.type === "get_snapshot" ? (result as { state: unknown }).state : result) as { sessionFile?: string; sessionId?: string }; if (this.sessionId && this.sessionId !== state.sessionId) forgetSession(this); this.sessionPath = state.sessionFile; this.sessionId = state.sessionId; }
    if (command.type === "get_snapshot") {
      for (const event of (result as { extensionState?: RpcEvent[] }).extensionState ?? []) this.emit(event);
    }
  }
  private emit(event: RpcEvent) {
    this.settings.observe(event);
    this.trackSessionActivity(event);
    this.retainExtensionState(event);
    if (event.type === "queue_update") this.queueSnapshot = event;
    if (["queue_update", "extension_ui_request", "extension_ui_resolved"].includes(event.type)) {
      retainSessionResource(this, "transport", [this.queueSnapshot, ...this.retainedStatuses.values(), ...this.retainedRequests.values()], () => {
        this.queueSnapshot = { type: "queue_update", steering: [], followUp: [], pendingMessages: [] };
        this.retainedStatuses.clear(); this.retainedRequests.clear();
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
    this.retainedStatuses.clear(); this.retainedRequests.clear();
    this.presenceCleanup?.(); this.presenceCleanup = undefined;
  }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string, ephemeral = false) {
    if (this.disposed) throw new Error("This conversation view has been closed");
    this.ephemeral ||= ephemeral;
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) { this.sessionPath = sessionPath; this.sessionId = undefined; } if (hostId !== undefined) this.hostId = hostId;
    if (this.running) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectionAttempted = true;
    const pending = this.establishConnection(forkPath, ephemeral); this.connectPromise = pending;
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
  private async establishConnection(forkPath?: string, _ephemeral = false) {
    const version = ++this.connectionVersion;
    await this.resolveHomeDirectory(version);
    if (version !== this.connectionVersion) return;
    if (!await this.ensureConnectionDirectory(version)) return;
    this.conversationCommands.reset();
    this.clearConnectionListeners();
    const unlisten = await listen<RpcEvent | { runtimeId: string; event: RpcEvent }>("pi://event", ({ payload }) => {
      const envelope = payload as { runtimeId?: unknown; event?: RpcEvent };
      if (typeof envelope.runtimeId === "string") { if (envelope.runtimeId === this.runtimeId && envelope.event) { if (envelope.event.type === "ownership_lost") { this.owns = false; this.retainedRequests.clear(); } if (envelope.event.type === "disconnected") this.connectionLost(); this.emit(envelope.event); } }
      else {
        const event = payload as RpcEvent;
        if (event.type === "disconnected") this.connectionLost();
        this.emit(event);
      }
    });
    const stderrUnlisten = await listen<{ runtimeId?: string; line?: string } | string>("pi://stderr", ({ payload }) => {
      const runtimeId = typeof payload === "string" ? this.runtimeId : payload.runtimeId;
      const line = typeof payload === "string" ? payload : payload.line;
      if (runtimeId !== this.runtimeId || !line?.trim()) return;
      this.stderrLines = [...this.stderrLines.slice(-4), line.trim()];
    });
    if (version !== this.connectionVersion) { unlisten(); stderrUnlisten(); return; }
    this.unlisten = unlisten; this.stderrUnlisten = stderrUnlisten;
    const attached = await this.runProcessCommand(() => version !== this.connectionVersion ? Promise.resolve(undefined) : call<{ attached: boolean; owned?: boolean; daemonId?: string }>("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, sessionPath: !this.readOnly && this.sessionId ? undefined : this.sessionPath, sessionId: this.sessionId, forkPath, noSession: this.ephemeral, hostId: this.hostId, presence: this.presence() }));
    if (version !== this.connectionVersion || !attached) throw new Error("The conversation disconnected while starting. Reconnect to try again.");
    this.daemonId = attached.daemonId;
    this.connectedOwnership(attached);
    if (version === this.connectionVersion) {
      this.running = true;
      this.presenceCleanup?.();
      window.addEventListener("focus", this.publishPresence); window.addEventListener("blur", this.publishPresence); document.addEventListener("visibilitychange", this.publishPresence);
      this.presenceCleanup = () => { window.removeEventListener("focus", this.publishPresence); window.removeEventListener("blur", this.publishPresence); document.removeEventListener("visibilitychange", this.publishPresence); };
      this.publishPresence();
    }
  }
  private connectedOwnership(attached: { attached: boolean; owned?: boolean } | undefined) {
    if (attached?.attached) this.fresh = false;
    this.owns = !this.readOnly && attached?.owned !== false;
    this.emit({ type: this.owns ? "ownership_acquired" : "ownership_lost" });
  }
  async disconnect(discardBlank = false) { ++this.connectionVersion; this.presenceCleanup?.(); this.presenceCleanup = undefined; this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; const stopped = await this.runProcessCommand(() => call<boolean>("stop_pi", { runtimeId: this.runtimeId, discardBlank })); this.running = false; this.retainedStatuses.clear(); this.retainedRequests.clear(); return stopped; }
  reconnectForSettings(settings: AppSettings) { return this.settings.reconnect(settings); }
  async dispose() { this.disposed = true; await this.settings.dispose(); const temporaryPath = this.temporaryChat && !this.temporaryChatUsed ? this.cwd : undefined; const temporaryHost = this.hostId; const stopped = await this.disconnect(true); if (temporaryPath && (stopped || !this.connectionAttempted)) await call<void>("remove_temporary_chat", { path: temporaryPath, hostId: temporaryHost }); this.temporaryChat = false; this.temporaryChatUsed = false; }
  toggleFastMode() { return this.conversationCommands.toggleFastMode(); }
  setFastMode(enabled: boolean) { return this.conversationCommands.setFastMode(enabled); }
  command<T>(command: RpcCommand): Promise<T> { return this.executeCommand<T>(command); }
  changePendingMessage(id: string, action: import("../types").PendingMessageAction): Promise<void> {
    return this.executeCommand({ type: "change_pending", id, action });
  }
  private executeCommand<T>(command: RpcCommand): Promise<T> {
    return this.settings.runCommand(() => this.executeCommandNow<T>(command));
  }
  private sendCommand<T>(command: RpcCommand) { return call<T>("pi_command", { runtimeId: this.runtimeId, command }); }
  private async executeCommandNow<T>(command: RpcCommand) {
    command = this.conversationCommands.normalize(command);
    try {
      const result = await this.sendCommand<T>(command);
      this.retainCommandSession(command, result);
      this.resetChangedSession(command, result);
      const followUp = this.conversationCommands.afterCommand(command, result);
      if (followUp) await followUp;
      if (command.type === "extension_ui_response" && typeof command.id === "string") this.retainedRequests.delete(command.id);
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason); const diagnostics = this.stderrLines.join("\n");
      throw new Error(diagnostics && /disconnect|connect|start|running/i.test(message) ? `${message}\n${diagnostics}` : message);
    }
  }
  private resetChangedSession(command: RpcCommand, result: unknown) {
    if (["new_session", "switch_session", "fork", "fork_after", "clone"].includes(command.type) && !(result as { cancelled?: boolean })?.cancelled) { forgetSession(this); this.sessionId = undefined; }
  }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); listener(this.queueView()); this.retainedStatuses.forEach((event) => listener(event)); this.retainedRequests.forEach((event) => listener(event)); return () => this.listeners.delete(listener); }
  listSessions() { return call<SessionSummary[]>("list_sessions"); }
  captureGitTree(cwd: string, hostId = "local") { return call<string | null>("capture_git_tree", { cwd, hostId }); }
  discardGitTree(snapshot: string, hostId = "local") { return call<void>("discard_git_tree", { snapshot, hostId }); }
  loadGitDiff(cwd: string, baseTree: string, hostId = "local") { return call<GitDiffSnapshot | null>("load_git_diff", { cwd, baseTree, hostId }); }
  loadGitDiffs(sessionPath: string, hostId = "local") { return call<GitDiffSnapshots>("load_git_diffs", { sessionPath, hostId }); }
  saveGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId = "local") { return call<void>("save_git_diffs", { sessionPath, snapshots, hostId }); }
  archiveSession(sessionPath: string, hostId = "local", terminalIds: string[] = []) { return call<void>("archive_session", { sessionPath, hostId, terminalIds }); }
  deleteSession(sessionPath: string, hostId = "local") { return call<void>("delete_session", { sessionPath, hostId }); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return call<void>("relocate_session", { sessionPath, cwd, hostId }); }
  openProjectDirectory(cwd: string, hostId = "local") { return call<void>("open_project_directory", { cwd, hostId }); }
  createProjectWorktree(cwd: string, name: string, hostId = "local") { return call<GitWorktree>("create_project_worktree", { cwd, name, hostId }); }
  createGitWorktree(cwd: string, name: string, hostId = "local") { return call<GitWorktree>("create_git_worktree", { cwd, name, hostId }); }
  removeGitWorktree(cwd: string, hostId = "local", deleteBranch = false) { return call<GitWorktreeRemoval>("remove_git_worktree", { cwd, hostId, deleteBranch }); }
  async runWorktreeSetup(cwd: string, worktreePath: string, hostId = "local", onSetup?: (cancel: (() => Promise<void>) | undefined) => void) {
    const setupId = await call<string>("prepare_worktree_setup", { hostId });
    onSetup?.(() => call<void>("cancel_worktree_setup", { setupId }));
    try { await call<void>("run_worktree_setup", { setupId, cwd, worktreePath, hostId }); }
    finally { onSetup?.(undefined); }
  }
  async isGitRepository() { if (!this.cwd) return false; return call<boolean>("is_git_repository", { cwd: this.cwd, hostId: this.hostId }); }
  async gitBranch() { if (!this.cwd) return null; const branch = await call<unknown>("git_branch", { cwd: this.cwd, hostId: this.hostId }); return typeof branch === "string" ? branch : null; }
  loadSettings() { return this.settings.load(); }
  loadHostSettings() { return this.settings.loadHost(); }
  saveHostSettings(settings: AppSettings, agentsChanged = false) { return this.settings.saveHost(settings, agentsChanged); }
  loadCodexUsage() { return call<CodexUsage>("codex_usage"); }
  loadOpencodeGoUsage() { return call<OpencodeGoUsage>("opencode_go_usage"); }
  saveSettings(settings: AppSettings, reconnect = true, agentHostId?: string) { return this.settings.save(settings, reconnect, agentHostId); }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  homeDirectory(hostId: string) { return call<string>("home_directory", { hostId }); }
  validateProjectDirectory(path: string, hostId: string) { return call<string>("validate_project_directory", { path, hostId }); }
  listDirectories(hostId: string, path?: string) { return call<DirectoryListing>("list_directories", { hostId, path }); }
  async prepareTemporaryChat(hostId: string) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false; return chat.cwd; }
  startTerminal(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId = this.hostId) {
    if (cwd === this.cwd && hostId === this.hostId) { this.terminalActivity = true; this.temporaryChatUsed = true; }
    const pending = call<void>("start_terminal", { terminalId, sessionKey, cwd, cols, rows, hostId });
    terminalStarts.set(terminalId, pending);
    const clear = () => { if (terminalStarts.get(terminalId) === pending) terminalStarts.delete(terminalId); };
    void pending.then(clear, clear);
    return pending;
  }
  writeTerminal(terminalId: string, data: string) {
    const starting = terminalStarts.get(terminalId);
    const next = (terminalWrites.get(terminalId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => starting).then(() => call<void>("write_terminal", { terminalId, data }));
    terminalWrites.set(terminalId, next);
    const clear = () => { if (terminalWrites.get(terminalId) === next) terminalWrites.delete(terminalId); };
    void next.then(clear, clear);
    return next;
  }
  async resizeTerminal(terminalId: string, cols: number, rows: number) { await terminalStarts.get(terminalId); return call<void>("resize_terminal", { terminalId, cols, rows }); }
  async reassignTerminal(terminalId: string, sessionKey: string) { await terminalStarts.get(terminalId); return call<void>("reassign_terminal", { terminalId, sessionKey }); }
  async closeTerminal(terminalId: string) { await terminalStarts.get(terminalId)?.catch(() => undefined); await terminalWrites.get(terminalId)?.catch(() => undefined); terminalWrites.delete(terminalId); return call<void>("close_terminal", { terminalId }); }
}

export async function readDroppedFile(path: string): Promise<File> {
  const result = await call<{ name: string; data: number[] }>("read_dropped_file", { path });
  const extension = result.name.split(".").pop()?.toLowerCase() ?? "";
  const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return new File([new Uint8Array(result.data)], result.name, { type: imageTypes[extension] ?? "" });
}
