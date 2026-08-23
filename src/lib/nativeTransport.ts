import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, PiTransport, RpcCommand, RpcEvent, SessionSummary } from "../types";

export class NativeTransport implements PiTransport {
  mode = "native" as const;
  private listeners = new Set<(event: RpcEvent) => void>();
  private unlisten?: UnlistenFn;
  private connectionVersion = 0;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private cwd?: string;
  private sessionPath?: string;
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  async connect(cwd?: string, sessionPath?: string) {
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) this.sessionPath = sessionPath;
    const version = ++this.connectionVersion;
    this.unlisten?.(); this.unlisten = undefined;
    const unlisten = await listen<RpcEvent>("pi://event", ({ payload }) => this.listeners.forEach((listener) => listener(payload)));
    if (version !== this.connectionVersion) { unlisten(); return; }
    this.unlisten = unlisten;
    await this.runProcessCommand(() => invoke("start_pi", { cwd: this.cwd, sessionPath: this.sessionPath }));
  }
  async disconnect() { ++this.connectionVersion; this.unlisten?.(); this.unlisten = undefined; await this.runProcessCommand(() => invoke("stop_pi")); }
  async command<T>(command: RpcCommand) { const result = await invoke<T>("pi_command", { command }); if (command.type === "get_state") this.sessionPath = (result as { sessionFile?: string }).sessionFile; return result; }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listSessions() { return invoke<SessionSummary[]>("list_sessions"); }
  archiveSession(sessionPath: string) { return invoke<void>("archive_session", { sessionPath }); }
  relocateSession(sessionPath: string, cwd: string) { return invoke<void>("relocate_session", { sessionPath, cwd }); }
  loadSettings() { return invoke<AppSettings>("load_app_settings"); }
  async saveSettings(settings: AppSettings) { await invoke<void>("save_app_settings", { settings }); await this.disconnect(); await this.connect(this.cwd, this.sessionPath); }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  async openProject(cwd: string) { await this.disconnect(); this.cwd = cwd; this.sessionPath = undefined; await this.connect(cwd); }
  startTerminal(terminalId: string, cwd: string, cols: number, rows: number) { return invoke<void>("start_terminal", { terminalId, cwd, cols, rows }); }
  writeTerminal(terminalId: string, data: string) { return invoke<void>("write_terminal", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return invoke<void>("resize_terminal", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return invoke<void>("close_terminal", { terminalId }); }
}
