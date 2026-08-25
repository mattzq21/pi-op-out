import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, CodexUsage, DirectoryListing, GitDiffSnapshot, GitDiffSnapshots, PiTransport, RpcCommand, RpcEvent, SavedTerminalState, SessionEntries, SessionSummary } from "../types";

export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; }

export class NativeTransport implements PiTransport {
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private listeners = new Set<(event: RpcEvent) => void>();
  private unlisten?: UnlistenFn;
  private connectionVersion = 0;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private cwd?: string;
  private sessionPath?: string;
  private sessionId?: string;
  private hostId = "local";
  private running = false;
  constructor(target: NativeConnectionTarget = {}) { this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  currentHostId() { return this.hostId; }
  currentCwd() { return this.cwd; }
  currentSessionPath() { return this.sessionPath; }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string) {
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) { this.sessionPath = sessionPath; this.sessionId = undefined; } if (hostId !== undefined) this.hostId = hostId;
    if (this.running) return;
    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await invoke<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId: this.hostId }); this.cwd = chat.cwd; this.sessionId = chat.sessionId; }
    const version = ++this.connectionVersion;
    this.unlisten?.(); this.unlisten = undefined;
    const unlisten = await listen<RpcEvent | { runtimeId: string; event: RpcEvent }>("pi://event", ({ payload }) => {
      const envelope = payload as { runtimeId?: unknown; event?: RpcEvent };
      if (typeof envelope.runtimeId === "string") { if (envelope.runtimeId === this.runtimeId && envelope.event) { if (envelope.event.type === "disconnected") this.running = false; this.listeners.forEach((listener) => listener(envelope.event!)); } }
      else this.listeners.forEach((listener) => listener(payload as RpcEvent));
    });
    if (version !== this.connectionVersion) { unlisten(); return; }
    this.unlisten = unlisten;
    await this.runProcessCommand(() => invoke("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, forkPath, hostId: this.hostId })); this.running = true;
  }
  async disconnect() { ++this.connectionVersion; this.unlisten?.(); this.unlisten = undefined; if (this.running) await this.runProcessCommand(() => invoke("stop_pi", { runtimeId: this.runtimeId })); this.running = false; }
  async command<T>(command: RpcCommand) { const compact = command.type === "prompt" && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null; if (compact) command = { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) }; const result = await invoke<T>("pi_command", { runtimeId: this.runtimeId, command }); if (command.type === "get_state") { this.sessionPath = (result as { sessionFile?: string }).sessionFile; this.sessionId = undefined; } return result; }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listSessions() { return invoke<SessionSummary[]>("list_sessions"); }
  loadSessionEntries(sessionPath: string, hostId = "local") { return invoke<SessionEntries>("load_session_entries", { sessionPath, hostId }); }
  captureGitTree(cwd: string, hostId = "local") { return invoke<string | null>("capture_git_tree", { cwd, hostId }); }
  loadGitDiff(cwd: string, baseTree: string, hostId = "local") { return invoke<GitDiffSnapshot | null>("load_git_diff", { cwd, baseTree, hostId }); }
  loadGitDiffs(sessionPath: string, hostId = "local") { return invoke<GitDiffSnapshots>("load_git_diffs", { sessionPath, hostId }); }
  saveGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId = "local") { return invoke<void>("save_git_diffs", { sessionPath, snapshots, hostId }); }
  archiveSession(sessionPath: string, hostId = "local", terminalState?: SavedTerminalState) { return invoke<void>("archive_session", { sessionPath, hostId, terminalState }); }
  deleteSession(sessionPath: string, hostId = "local") { return invoke<void>("delete_session", { sessionPath, hostId }); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return invoke<void>("relocate_session", { sessionPath, cwd, hostId }); }
  openProjectDirectory(cwd: string, hostId = "local") { return invoke<void>("open_project_directory", { cwd, hostId }); }
  openLogViewer(sessionPath: string, hostId = "local") { return invoke<void>("open_log_viewer", { sessionPath, hostId }); }
  gitBranch() { return invoke<string | null>("git_branch"); }
  loadSettings() { return invoke<AppSettings>("load_app_settings"); }
  loadCodexUsage() { return invoke<CodexUsage>("codex_usage"); }
  async saveSettings(settings: AppSettings) { await invoke<void>("save_app_settings", { settings }); if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) this.hostId = "local"; await this.disconnect(); await this.connect(this.cwd, this.sessionPath, this.hostId); }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  homeDirectory(hostId: string) { return invoke<string>("home_directory", { hostId }); }
  listDirectories(hostId: string, path?: string) { return invoke<DirectoryListing>("list_directories", { hostId, path }); }
  async newTemporaryChat(hostId: string) { await this.disconnect(); const chat = await invoke<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; await this.connect(chat.cwd, undefined, hostId); return chat.cwd; }
  async prepareTemporaryChat(hostId: string) { const chat = await invoke<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; return chat.cwd; }
  async newChat(cwd: string, hostId = "local") { await this.disconnect(); this.cwd = cwd; this.sessionPath = undefined; this.sessionId = undefined; this.hostId = hostId; await this.connect(cwd, undefined, hostId); }
  openProject(cwd: string, hostId = "local") { return this.newChat(cwd, hostId); }
  startTerminal(terminalId: string, cwd: string, cols: number, rows: number) { return invoke<void>("start_terminal", { terminalId, cwd, cols, rows, hostId: this.hostId }); }
  writeTerminal(terminalId: string, data: string) { return invoke<void>("write_terminal", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return invoke<void>("resize_terminal", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return invoke<void>("close_terminal", { terminalId }); }
}
