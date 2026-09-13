/// <reference types="vite/client" />
import { applyAssistantMessageEvent, normalizeMessage, type PiEntry } from "./messages";
import type { ChatMessage } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { GroupChange, SessionGroups, SessionGroupSeed } from "./sessionGroups";
import type { AppSettings, CodexUsage, DirectoryListing, GitDiffSnapshot, GitDiffSnapshots, PendingMessage, RpcCommand, RpcEvent, SessionSummary, SettingsChange, StorageReport } from "../types";

const call = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.MODE !== "e2e") return invoke<T>(command, args);
  const key = command === "pi_command" ? `${command}:${String((args?.command as RpcCommand)?.type)}` : command;
  const responseField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-responses"); const callField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls");
  const responses = JSON.parse(responseField?.value || "{}");
  if (callField?.value) { const calls = JSON.parse(callField.value); calls.push({ command, args, mocked: key in responses }); callField.value = JSON.stringify(calls); }
  if (!(key in responses)) return invoke<T>(command, args);
  const response = responses[key]; return response?.error ? Promise.reject(new Error(response.error)) : Promise.resolve(response as T);
};

export const openSessionWindow = (target: NativeConnectionTarget & { sessionId: string }) => call<string>("new_window", { target });
export function initialWindowTarget(): NativeConnectionTarget {
  try { const value = JSON.parse(new URLSearchParams(window.location.search).get("target") || "{}"); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}
export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; }
export const loadSessionGroups = (seeds: SessionGroupSeed[], legacy: SessionGroups) => call<SessionGroups>("load_session_groups", { seeds, legacy });
export const changeSessionGroups = (change: GroupChange) => call<SessionGroups>("change_session_groups", { change });
export const openGroupDirectory = (cwd: string, hostId: string) => call<void>("open_project_directory", { cwd, hostId });
export const gitProjectKind = (cwd: string, hostId: string) => call<"no-repo" | "main" | "worktree">("git_project_kind", { cwd, hostId });
export const gitWorktreeRoots = (paths: string[], hostId: string) => call<Array<string | null>>("git_worktree_roots", { paths, hostId });
export interface GitWorktree { branch: string; path: string; }
export interface GitWorktreeRemoval { branch?: string; branchDeleted: boolean; warning?: string; }

export const openExternalUrl = (url: string) => call<void>("open_external_url", { url });
export const loadStorageReport = () => call<StorageReport>("storage_report");
export const deleteArchivedConversation = (sessionPath: string, hostId = "local") => call<void>("delete_archived_session", { sessionPath, hostId });
export interface HookListing { directory: string; exists: boolean; hooks: Array<{ name: string; path: string; entry: string }> }
export const listHooks = (hostId: string) => call<HookListing>("list_hooks", { hostId });
export const openHooksDirectory = (cwd: string) => call<void>("open_project_directory", { cwd, hostId: "local" });

export class NativeTransport {
  private liveAssistant?: ChatMessage;
  private ephemeral = false;
  private fresh = true;
  needsDefaults() { return this.fresh; }
  defaultsApplied() { this.fresh = false; }
  connectionTarget(): NativeConnectionTarget { return { cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId }; }
  async restoreConnection(target: NativeConnectionTarget) { await this.disconnect(); this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId || "local"; await this.connect(); }
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private queueSnapshot: RpcEvent = { type: "queue_update", steering: [], followUp: [], pendingMessages: [] };
  private visible = false;
  private presenceCleanup?: () => void;
  setVisible(visible: boolean) { this.visible = visible; this.publishPresence(); }
  private presence() { return { visible: this.visible && document.visibilityState !== "hidden", focused: document.hasFocus() }; }
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
  private settingsLifecycle: Promise<unknown> = Promise.resolve();
  private pendingSettings?: { settings: AppSettings };
  private daemonSettingsPending = false;
  private applyingSettings?: Promise<void>;
  private settingsApplyFailed = false;
  private activeCommands = 0;
  private disposed = false;
  hasPendingSettings() { return Boolean(this.daemonSettingsPending || this.pendingSettings || this.applyingSettings); }
  queueSettings(settings: AppSettings, changes: { reconnect: boolean }) {
    if (this.disposed || (!this.pendingSettings && !changes.reconnect)) return;
    this.pendingSettings = { settings: structuredClone(settings) };
    this.settingsApplyFailed = false;
    this.emit({ type: "settings_pending" });
    this.applyPendingSettings();
  }
  private applyPendingSettings() {
    if (!this.pendingSettings || this.applyingSettings || this.activeCommands || this.disposed || this.settingsApplyFailed) return;
    this.applyingSettings = Promise.resolve().then(async () => {
      while (this.pendingSettings && !this.disposed) {
        const update = this.pendingSettings;
        await this.reconnectForSettings(update.settings);
        if (this.pendingSettings === update) this.pendingSettings = undefined;
        this.emit({ type: "settings_applied" });
      }
    }).catch((reason) => {
      this.settingsApplyFailed = true;
      this.emit({ type: "extension_error", error: `Settings saved, but this session could not apply them: ${reason instanceof Error ? reason.message : String(reason)}. Save again to retry.` });
    }).finally(() => {
      this.applyingSettings = undefined;
      this.emit({ type: "settings_pending" });
    });
  }
  private cwd?: string;
  private sessionPath?: string;
  private sessionId?: string;
  private hostId = "local";
  private running = false;
  private temporaryChat = false;
  private temporaryChatUsed = false;
  private fastStatusCommand?: string;
  private fastCommands = new Set<string>();
  constructor(target: NativeConnectionTarget = {}) { this.fresh = !target.sessionPath && !target.sessionId; this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  currentHostId() { return this.hostId; }
  currentCwd() { return this.cwd; }
  currentSessionPath() { return this.sessionPath; }
  isTemporaryChat() { return this.temporaryChat; }
  lastDiagnostic() { return this.stderrLines.join("\n"); }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  private queueView(): RpcEvent { return this.queueSnapshot; }
  private emit(event: RpcEvent) {
    if (event.type === "settings_pending" && typeof event.pending === "boolean") this.daemonSettingsPending = event.pending;
    if (event.type === "disconnected") this.daemonSettingsPending = false;
    if (event.type === "agent_start" || (event.type === "message_start" && (event.message as { role?: string })?.role === "user")) this.temporaryChatUsed = true;
    if (event.type === "session_switched") this.liveAssistant = undefined;
    if ((event.type === "message_start" || event.type === "message_end") && (event.message as { role?: string })?.role === "assistant") this.liveAssistant = { ...normalizeMessage(event.message as Record<string, unknown>, undefined, undefined, this.liveAssistant?.streaming ? this.liveAssistant.id : `live-assistant-${crypto.randomUUID()}`), streaming: event.type === "message_start" };
    if (event.type === "message_update" && event.assistantMessageEvent && this.liveAssistant) this.liveAssistant = applyAssistantMessageEvent(this.liveAssistant, event.assistantMessageEvent);

    if (event.type === "extension_ui_resolved" && typeof event.id === "string") this.retainedRequests.delete(event.id);
    if (event.type === "queue_update") this.queueSnapshot = event;
    if (event.type === "extension_ui_request" && event.method === "setStatus" && typeof event.statusKey === "string") {
      if (event.statusText) this.retainedStatuses.set(event.statusKey, event); else this.retainedStatuses.delete(event.statusKey);
    }
    if (event.type === "extension_ui_request" && ["input", "editor", "select", "confirm"].includes(String(event.method)) && typeof event.id === "string") this.retainedRequests.set(event.id, event);
    this.listeners.forEach((listener) => listener(event));
    if (["agent_settled", "auto_compaction_end", "queue_update"].includes(event.type)) this.applyPendingSettings();
  }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string, ephemeral = false) {
    this.ephemeral ||= ephemeral;
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) { this.sessionPath = sessionPath; this.sessionId = undefined; } if (hostId !== undefined) this.hostId = hostId;
    if (this.running) return;
    if (this.connectPromise) return this.connectPromise;
    const pending = this.establishConnection(forkPath, ephemeral); this.connectPromise = pending;
    try { await pending; } finally { if (this.connectPromise === pending) this.connectPromise = undefined; }
  }
  private async establishConnection(forkPath?: string, _ephemeral = false) {
    const version = ++this.connectionVersion;
    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId: this.hostId, e2e: import.meta.env.MODE === "e2e" }); if (version !== this.connectionVersion) { await call<void>("remove_temporary_chat", { path: chat.cwd, hostId: this.hostId }); return; } this.cwd = chat.cwd; this.sessionId = chat.sessionId; this.temporaryChat = true; }
    this.fastStatusCommand = undefined; this.fastCommands.clear();
    this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.stderrLines = [];
    const unlisten = await listen<RpcEvent | { runtimeId: string; event: RpcEvent }>("pi://event", ({ payload }) => {
      const envelope = payload as { runtimeId?: unknown; event?: RpcEvent };
      if (typeof envelope.runtimeId === "string") { if (envelope.runtimeId === this.runtimeId && envelope.event) { if (envelope.event.type === "disconnected") { this.running = false; this.retainedStatuses.clear(); this.retainedRequests.clear(); } this.emit(envelope.event); } }
      else this.emit(payload as RpcEvent);
    });
    const stderrUnlisten = await listen<{ runtimeId?: string; line?: string } | string>("pi://stderr", ({ payload }) => {
      const runtimeId = typeof payload === "string" ? this.runtimeId : payload.runtimeId;
      const line = typeof payload === "string" ? payload : payload.line;
      if (runtimeId !== this.runtimeId || !line?.trim()) return;
      this.stderrLines = [...this.stderrLines.slice(-4), line.trim()];
    });
    if (version !== this.connectionVersion) { unlisten(); stderrUnlisten(); return; }
    this.unlisten = unlisten; this.stderrUnlisten = stderrUnlisten;
    // Pi can resume by ID before a fresh session has a file on disk.
    const attached = await this.runProcessCommand(() => version !== this.connectionVersion ? Promise.resolve(undefined) : call<{ attached: boolean }>("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, sessionPath: this.sessionId ? undefined : this.sessionPath, sessionId: this.sessionId, forkPath, noSession: this.ephemeral, hostId: this.hostId, presence: this.presence() }));
    if (attached?.attached) this.fresh = false;
    if (version === this.connectionVersion) {
      this.running = true;
      this.presenceCleanup?.();
      window.addEventListener("focus", this.publishPresence); window.addEventListener("blur", this.publishPresence); document.addEventListener("visibilitychange", this.publishPresence);
      this.presenceCleanup = () => { window.removeEventListener("focus", this.publishPresence); window.removeEventListener("blur", this.publishPresence); document.removeEventListener("visibilitychange", this.publishPresence); };
      this.publishPresence();
    }
  }
  async disconnect(discardBlank = false) { ++this.connectionVersion; this.presenceCleanup?.(); this.presenceCleanup = undefined; this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; const stopped = await this.runProcessCommand(() => call<boolean>("stop_pi", { runtimeId: this.runtimeId, discardBlank })); this.running = false; this.retainedStatuses.clear(); this.retainedRequests.clear(); return stopped; }
  async reconnectForSettings(settings: AppSettings) {
    await this.disconnect();
    if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) { this.hostId = "local"; this.cwd = undefined; this.sessionPath = undefined; this.sessionId = undefined; this.temporaryChat = false; this.temporaryChatUsed = false; this.fresh = true; }
    try { await this.connect(); }
    catch (reason) { this.emit({ type: "disconnected" }); throw reason; }
  }
  async dispose() { this.disposed = true; this.pendingSettings = undefined; await this.applyingSettings; const temporaryPath = this.temporaryChat && !this.temporaryChatUsed ? this.cwd : undefined; const temporaryHost = this.hostId; const stopped = await this.disconnect(true); if (temporaryPath && stopped) await call<void>("remove_temporary_chat", { path: temporaryPath, hostId: temporaryHost }); this.temporaryChat = false; this.temporaryChatUsed = false; }
  private async refreshFastStatus(reload: boolean) {
    if (!this.fastStatusCommand) return;
    try {
      // Internal queries must not count as prompts that keep a temporary chat.
      await call("pi_command", { runtimeId: this.runtimeId, command: { type: "prompt", message: `/${this.fastStatusCommand}${reload ? " refresh" : ""}` } });
    } catch {
      this.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: "Fast mode status unavailable" });
    }
  }
  async toggleFastMode() {
    await this.changeFastMode("toggle");
  }
  async setFastMode(enabled: boolean) {
    await this.command({ type: "get_commands" });
    await this.changeFastMode(enabled ? "on" : "off");
  }
  private async changeFastMode(mode: "on" | "off" | "toggle") {
    const command = this.fastCommands.values().next().value;
    if (!command) throw new Error("Fast mode is unavailable in this conversation");
    await call("pi_command", { runtimeId: this.runtimeId, command: { type: "prompt", message: `/${command} ${mode}` } });
    await this.refreshFastStatus(true);
  }
  command<T>(command: RpcCommand): Promise<T> { return this.executeCommand<T>(command); }
  changePendingMessage(id: string, action: import("../types").PendingMessageAction): Promise<void> {
    return this.executeCommand({ type: "change_pending", id, action });
  }
  private async executeCommand<T>(command: RpcCommand): Promise<T> {
    if (this.applyingSettings) await this.applyingSettings;
    this.activeCommands += 1;
    try { return await this.executeCommandNow<T>(command); }
    finally { this.activeCommands -= 1; this.applyPendingSettings(); }
  }
  private async executeCommandNow<T>(command: RpcCommand) {
    const compact = command.type === "prompt" && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;
    if (compact) command = { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) };
    try {
      const result = await call<T>("pi_command", { runtimeId: this.runtimeId, command });
      if (command.type === "get_state" || command.type === "get_snapshot") { const state = (command.type === "get_snapshot" ? (result as { state: unknown }).state : result) as { sessionFile?: string; sessionId?: string }; if (this.sessionId && this.sessionId !== state.sessionId) this.liveAssistant = undefined; this.sessionPath = state.sessionFile; this.sessionId = state.sessionId; }
      if (command.type === "get_entries") {
        const history = result as { entries: Array<{ message?: { role?: string; timestamp?: number; deliveryBehavior?: string } }> };
        const live = this.liveAssistant; const branch = result as { entries: PiEntry[]; leafId: string | null };
        if (live?.streaming && !history.entries.some((entry) => entry.message?.role === "assistant" && entry.message.timestamp === live.timestamp)) {
          branch.entries.push({ type: "message", id: live.id, parentId: branch.leafId, message: live } as PiEntry); branch.leafId = live.id;
        }
      }
      if (["new_session", "switch_session", "fork", "clone"].includes(command.type) && !(result as { cancelled?: boolean })?.cancelled) { this.liveAssistant = undefined; this.sessionId = undefined; }
      if (command.type === "get_commands") {
        const { commands } = result as { commands: Array<{ name: string; source: string; sourceInfo?: { source?: string; path?: string } }> };
        const fromPackage = (item: typeof commands[number], name: string) => item.sourceInfo?.source === `npm:${name}` || item.sourceInfo?.path?.split(/[\\/]/).includes(name);
        const fastCommands = commands.filter((item) => item.source === "extension" && /^fast(?::\d+)?$/.test(item.name) && ["pi-openai-fast-mode-piop", "pi-openai-fast-mode"].some((name) => fromPackage(item, name)));
        this.fastCommands = new Set(fastCommands.map((item) => item.name));
        // The local fork publishes its live state directly. Only the original
        // TUI-only package needs the compatibility query after each command.
        this.fastStatusCommand = fastCommands.some((item) => fromPackage(item, "pi-openai-fast-mode-piop")) ? undefined : commands.find((item) => item.source === "extension" && item.name === "pi-desktop-fast-status")?.name;
        await this.refreshFastStatus(false);
      }
      if (command.type === "prompt") {
        this.temporaryChatUsed = true;
        const invocation = typeof command.message === "string" ? command.message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/) : undefined;
        if (invocation && this.fastCommands.has(invocation[1]) && ["", "on", "off", "toggle"].includes((invocation[2] ?? "").trim().toLowerCase())) await this.refreshFastStatus(true);
      }
      if (command.type === "extension_ui_response" && typeof command.id === "string") this.retainedRequests.delete(command.id);
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason); const diagnostics = this.stderrLines.join("\n");
      throw new Error(diagnostics && /disconnect|connect|start|running/i.test(message) ? `${message}\n${diagnostics}` : message);
    }
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
    const setupId = await call<string>("prepare_worktree_setup");
    onSetup?.(() => call<void>("cancel_worktree_setup", { setupId }));
    try { await call<void>("run_worktree_setup", { setupId, cwd, worktreePath, hostId }); }
    finally { onSetup?.(undefined); }
  }
  async isGitRepository() { if (!this.cwd) return false; return call<boolean>("is_git_repository", { cwd: this.cwd, hostId: this.hostId }); }
  async gitBranch() { if (!this.cwd) return null; const branch = await call<unknown>("git_branch", { cwd: this.cwd, hostId: this.hostId }); return typeof branch === "string" ? branch : null; }
  loadSettings() { return call<AppSettings>("load_app_settings"); }
  loadCodexUsage() { return call<CodexUsage>("codex_usage"); }
  saveSettings(settings: AppSettings, reconnect = true, agentHostId?: string) {
    const save = async () => {
      const previous = await this.loadSettings(); const connection = { cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, hostId: this.hostId };
      const change = await call<SettingsChange>("save_app_settings", { settings, agentHostId }); if (!reconnect) return change;
      try { if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) { this.hostId = "local"; this.cwd = undefined; this.sessionPath = undefined; this.sessionId = undefined; this.temporaryChat = false; this.temporaryChatUsed = false; } await this.disconnect(); await this.connect(); }
      catch (reason) {
        await call<void>("save_app_settings", { settings: previous }); this.cwd = connection.cwd; this.sessionPath = connection.sessionPath; this.sessionId = connection.sessionId; this.hostId = connection.hostId;
        try { await this.disconnect(); await this.connect(); } catch { /* Preserve the original failure; the persisted settings are already restored. */ }
        throw reason;
      }
      return change;
    };
    const result = this.settingsLifecycle.then(save, save);
    this.settingsLifecycle = result.then(() => undefined, () => undefined);
    return result;
  }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  homeDirectory(hostId: string) { return call<string>("home_directory", { hostId }); }
  validateProjectDirectory(path: string, hostId: string) { return call<string>("validate_project_directory", { path, hostId }); }
  listDirectories(hostId: string, path?: string) { return call<DirectoryListing>("list_directories", { hostId, path }); }
  async prepareTemporaryChat(hostId: string) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false; return chat.cwd; }
  startTerminal(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId = this.hostId) { return call<void>("start_terminal", { terminalId, sessionKey, cwd, cols, rows, hostId }); }
  writeTerminal(terminalId: string, data: string) { return call<void>("write_terminal", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return call<void>("resize_terminal", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return call<void>("close_terminal", { terminalId }); }
}

export async function readDroppedFile(path: string): Promise<File> {
  const result = await call<{ name: string; data: number[] }>("read_dropped_file", { path });
  const extension = result.name.split(".").pop()?.toLowerCase() ?? "";
  const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return new File([new Uint8Array(result.data)], result.name, { type: imageTypes[extension] ?? "" });
}
