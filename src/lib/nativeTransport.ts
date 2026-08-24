import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, CodexUsage, DirectoryListing, PiTransport, RpcCommand, RpcEvent, SessionSummary } from "../types";

export class NativeTransport implements PiTransport {
  mode = "native" as const;
  private listeners = new Set<(event: RpcEvent) => void>();
  private unlisten?: UnlistenFn;
  private connectionVersion = 0;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private cwd?: string;
  private sessionPath?: string;
  private hostId = "local";
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  async connect(cwd?: string, sessionPath?: string, hostId?: string) {
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) this.sessionPath = sessionPath; if (hostId !== undefined) this.hostId = hostId;
    const version = ++this.connectionVersion;
    this.unlisten?.(); this.unlisten = undefined;
    const unlisten = await listen<RpcEvent>("pi://event", ({ payload }) => this.listeners.forEach((listener) => listener(payload)));
    if (version !== this.connectionVersion) { unlisten(); return; }
    this.unlisten = unlisten;
    await this.runProcessCommand(() => invoke("start_pi", { cwd: this.cwd, sessionPath: this.sessionPath, hostId: this.hostId }));
  }
  async disconnect() { ++this.connectionVersion; this.unlisten?.(); this.unlisten = undefined; await this.runProcessCommand(() => invoke("stop_pi")); }
  async command<T>(command: RpcCommand) { const result = await invoke<T>("pi_command", { command }); if (command.type === "get_state") this.sessionPath = (result as { sessionFile?: string }).sessionFile; return result; }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listSessions() { return invoke<SessionSummary[]>("list_sessions"); }
  archiveSession(sessionPath: string, hostId = "local") { return invoke<void>("archive_session", { sessionPath, hostId }); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return invoke<void>("relocate_session", { sessionPath, cwd, hostId }); }
  loadSettings() { return invoke<AppSettings>("load_app_settings"); }
  loadCodexUsage() { return invoke<CodexUsage>("codex_usage"); }
  async saveSettings(settings: AppSettings) { await invoke<void>("save_app_settings", { settings }); if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) this.hostId = "local"; await this.disconnect(); await this.connect(this.cwd, this.sessionPath, this.hostId); }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  listDirectories(hostId: string, path?: string) { return invoke<DirectoryListing>("list_directories", { hostId, path }); }
  async openProject(cwd: string, hostId = "local") { await this.disconnect(); this.cwd = cwd; this.sessionPath = undefined; this.hostId = hostId; await this.connect(cwd, undefined, hostId); }
  startTerminal(terminalId: string, cwd: string, cols: number, rows: number) { return invoke<void>("start_terminal", { terminalId, cwd, cols, rows, hostId: this.hostId }); }
  writeTerminal(terminalId: string, data: string) { return invoke<void>("write_terminal", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return invoke<void>("resize_terminal", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return invoke<void>("close_terminal", { terminalId }); }
}
