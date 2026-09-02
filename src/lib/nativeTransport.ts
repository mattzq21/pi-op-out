/// <reference types="vite/client" />
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, CodexUsage, DirectoryListing, GitDiffSnapshot, GitDiffSnapshots, PiTransport, RpcCommand, RpcEvent, SavedTerminalState, SessionEntries, SessionSummary } from "../types";

const call = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.MODE !== "e2e") return invoke<T>(command, args);
  const key = command === "pi_command" ? `${command}:${String((args?.command as RpcCommand)?.type)}` : command;
  const responseField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-responses"); const callField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls");
  const responses = JSON.parse(responseField?.value || "{}");
  if (callField?.value) { const calls = JSON.parse(callField.value); calls.push({ command, args, mocked: key in responses }); callField.value = JSON.stringify(calls); }
  if (!(key in responses)) return invoke<T>(command, args);
  const response = responses[key]; return response?.error ? Promise.reject(new Error(response.error)) : Promise.resolve(response as T);
};

export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; }

export class NativeTransport implements PiTransport {
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private listeners = new Set<(event: RpcEvent) => void>();
  private retainedStatuses = new Map<string, RpcEvent>();
  private unlisten?: UnlistenFn;
  private stderrUnlisten?: UnlistenFn;
  private stderrLines: string[] = [];
  private connectionVersion = 0;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private settingsLifecycle: Promise<unknown> = Promise.resolve();
  private cwd?: string;
  private sessionPath?: string;
  private sessionId?: string;
  private hostId = "local";
  private running = false;
  private temporaryChat = false;
  private temporaryChatUsed = false;
  constructor(target: NativeConnectionTarget = {}) { this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  currentHostId() { return this.hostId; }
  currentCwd() { return this.cwd; }
  currentSessionPath() { return this.sessionPath; }
  isTemporaryChat() { return this.temporaryChat; }
  lastDiagnostic() { return this.stderrLines.join("\n"); }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  private emit(event: RpcEvent) {
    if (event.type === "extension_ui_request" && event.method === "setStatus" && typeof event.statusKey === "string") {
      if (event.statusText) this.retainedStatuses.set(event.statusKey, event); else this.retainedStatuses.delete(event.statusKey);
    }
    this.listeners.forEach((listener) => listener(event));
  }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string, ephemeral = false) {
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) { this.sessionPath = sessionPath; this.sessionId = undefined; } if (hostId !== undefined) this.hostId = hostId;
    if (this.running) return;
    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId: this.hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionId = chat.sessionId; this.temporaryChat = true; }
    const version = ++this.connectionVersion;
    this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.stderrLines = [];
    const unlisten = await listen<RpcEvent | { runtimeId: string; event: RpcEvent }>("pi://event", ({ payload }) => {
      const envelope = payload as { runtimeId?: unknown; event?: RpcEvent };
      if (typeof envelope.runtimeId === "string") { if (envelope.runtimeId === this.runtimeId && envelope.event) { if (envelope.event.type === "disconnected") { this.running = false; this.retainedStatuses.clear(); } this.emit(envelope.event); } }
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
    await this.runProcessCommand(() => call("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, forkPath, noSession: ephemeral, hostId: this.hostId }));
    if (version === this.connectionVersion) this.running = true;
  }
  async disconnect() { ++this.connectionVersion; this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; await this.runProcessCommand(() => call("stop_pi", { runtimeId: this.runtimeId })); this.running = false; this.retainedStatuses.clear(); }
  async dispose() { const temporaryPath = this.temporaryChat && !this.temporaryChatUsed ? this.cwd : undefined; const temporaryHost = this.hostId; await this.disconnect(); if (temporaryPath) await call<void>("remove_temporary_chat", { path: temporaryPath, hostId: temporaryHost }); this.temporaryChat = false; this.temporaryChatUsed = false; }
  async command<T>(command: RpcCommand) { const compact = command.type === "prompt" && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null; if (compact) command = { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) }; try { const result = await call<T>("pi_command", { runtimeId: this.runtimeId, command }); if (command.type === "get_state") { this.sessionPath = (result as { sessionFile?: string }).sessionFile; this.sessionId = undefined; } if (command.type === "prompt") this.temporaryChatUsed = true; return result; } catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); const diagnostics = this.stderrLines.join("\n"); throw new Error(diagnostics && /disconnect|connect|start|running/i.test(message) ? `${message}\n${diagnostics}` : message); } }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); this.retainedStatuses.forEach((event) => listener(event)); return () => this.listeners.delete(listener); }
  listSessions() { return call<SessionSummary[]>("list_sessions"); }
  loadSessionEntries(sessionPath: string, hostId = "local") { return call<SessionEntries>("load_session_entries", { sessionPath, hostId }); }
  captureGitTree(cwd: string, hostId = "local") { return call<string | null>("capture_git_tree", { cwd, hostId }); }
  discardGitTree(snapshot: string, hostId = "local") { return call<void>("discard_git_tree", { snapshot, hostId }); }
  loadGitDiff(cwd: string, baseTree: string, hostId = "local") { return call<GitDiffSnapshot | null>("load_git_diff", { cwd, baseTree, hostId }); }
  loadGitDiffs(sessionPath: string, hostId = "local") { return call<GitDiffSnapshots>("load_git_diffs", { sessionPath, hostId }); }
  saveGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId = "local") { return call<void>("save_git_diffs", { sessionPath, snapshots, hostId }); }
  archiveSession(sessionPath: string, hostId = "local", terminalState?: SavedTerminalState) { return call<void>("archive_session", { sessionPath, hostId, terminalState }); }
  deleteSession(sessionPath: string, hostId = "local") { return call<void>("delete_session", { sessionPath, hostId }); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return call<void>("relocate_session", { sessionPath, cwd, hostId }); }
  openProjectDirectory(cwd: string, hostId = "local") { return call<void>("open_project_directory", { cwd, hostId }); }
  gitBranch() { return call<string | null>("git_branch"); }
  loadSettings() { return call<AppSettings>("load_app_settings"); }
  loadCodexUsage() { return call<CodexUsage>("codex_usage"); }
  saveSettings(settings: AppSettings, reconnect = true) {
    const save = async () => {
      const previous = await this.loadSettings(); const connection = { cwd: this.cwd, sessionPath: this.sessionPath, hostId: this.hostId };
      await call<void>("save_app_settings", { settings }); if (!reconnect) return;
      try { if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) this.hostId = "local"; await this.disconnect(); await this.connect(this.cwd, this.sessionPath, this.hostId); }
      catch (reason) {
        await call<void>("save_app_settings", { settings: previous }); this.cwd = connection.cwd; this.sessionPath = connection.sessionPath; this.hostId = connection.hostId;
        try { await this.disconnect(); await this.connect(this.cwd, this.sessionPath, this.hostId); } catch { /* Preserve the original failure; the persisted settings are already restored. */ }
        throw reason;
      }
    };
    const result = this.settingsLifecycle.then(save, save);
    this.settingsLifecycle = result.then(() => undefined, () => undefined);
    return result;
  }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  homeDirectory(hostId: string) { return call<string>("home_directory", { hostId }); }
  validateProjectDirectory(path: string, hostId: string) { return call<string>("validate_project_directory", { path, hostId }); }
  listDirectories(hostId: string, path?: string) { return call<DirectoryListing>("list_directories", { hostId, path }); }
  async newTemporaryChat(hostId: string) { await this.disconnect(); const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false; await this.connect(chat.cwd, undefined, hostId); return chat.cwd; }
  async prepareTemporaryChat(hostId: string) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false; return chat.cwd; }
  async newChat(cwd: string, hostId = "local") { await this.disconnect(); this.cwd = cwd; this.sessionPath = undefined; this.sessionId = undefined; this.hostId = hostId; this.temporaryChat = false; this.temporaryChatUsed = false; await this.connect(cwd, undefined, hostId); }
  openProject(cwd: string, hostId = "local") { return this.newChat(cwd, hostId); }
  startTerminal(terminalId: string, cwd: string, cols: number, rows: number) { return call<void>("start_terminal", { terminalId, cwd, cols, rows, hostId: this.hostId }); }
  writeTerminal(terminalId: string, data: string) { return call<void>("write_terminal", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return call<void>("resize_terminal", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return call<void>("close_terminal", { terminalId }); }
}
