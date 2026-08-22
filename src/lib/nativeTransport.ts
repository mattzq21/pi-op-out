import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, PiTransport, RpcCommand, RpcEvent, SessionSummary } from "../types";

export class NativeTransport implements PiTransport {
  mode = "native" as const;
  private listeners = new Set<(event: RpcEvent) => void>();
  private unlisten?: UnlistenFn;
  private cwd?: string;
  private sessionPath?: string;
  async connect(cwd?: string, sessionPath?: string) {
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) this.sessionPath = sessionPath;
    this.unlisten = await listen<RpcEvent>("pi://event", ({ payload }) => this.listeners.forEach((listener) => listener(payload)));
    await invoke("start_pi", { cwd: this.cwd, sessionPath: this.sessionPath });
  }
  async disconnect() { this.unlisten?.(); await invoke("stop_pi"); }
  async command<T>(command: RpcCommand) { const result = await invoke<T>("pi_command", { command }); if (command.type === "get_state") this.sessionPath = (result as { sessionFile?: string }).sessionFile; return result; }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listSessions() { return invoke<SessionSummary[]>("list_sessions"); }
  relocateSession(sessionPath: string, cwd: string) { return invoke<void>("relocate_session", { sessionPath, cwd }); }
  loadSettings() { return invoke<AppSettings>("load_app_settings"); }
  async saveSettings(settings: AppSettings) { await invoke<void>("save_app_settings", { settings }); await this.disconnect(); await this.connect(this.cwd, this.sessionPath); }
  async openProject(cwd: string) { await this.disconnect(); this.cwd = cwd; this.sessionPath = undefined; await this.connect(cwd); }
}
