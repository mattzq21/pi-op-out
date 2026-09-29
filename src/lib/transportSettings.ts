import { preserveDaemonPreferences, saveClientSettings, withClientSettings } from "./clientSettings";
import { keybindingsError } from "./keybindings";
import type { AppSettings, RpcEvent, SettingsChange } from "../types";

export interface SettingsConnectionTarget {
  cwd?: string;
  sessionPath?: string;
  sessionId?: string;
  hostId: string;
}

type SettingsConnection = {
  target: () => SettingsConnectionTarget;
  select: (target: SettingsConnectionTarget) => void;
  resetToLocal: (resetDefaults: boolean) => void;
  disconnect: () => Promise<unknown>;
  connect: () => Promise<void>;
};

type SettingsServices = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  connection: SettingsConnection;
  emit: (event: RpcEvent) => void;
};

export class TransportSettings {
  private saveLifecycle: Promise<unknown> = Promise.resolve();
  private pending?: { settings: AppSettings };
  private daemonPending = false;
  private applying?: Promise<void>;
  private applyFailed = false;
  private activeCommands = 0;
  private disposed = false;

  constructor(private readonly services: SettingsServices) {}

  hasPending() { return Boolean(this.daemonPending || this.pending || this.applying); }

  queue(settings: AppSettings, changes: { reconnect: boolean }) {
    if (this.disposed || (!this.pending && !changes.reconnect)) return;
    this.pending = { settings: structuredClone(settings) };
    this.applyFailed = false;
    this.services.emit({ type: "settings_pending" });
    this.applyPending();
  }

  private applyPending() {
    if (!this.pending || this.applying || this.activeCommands || this.disposed || this.applyFailed) return;
    this.applying = Promise.resolve().then(async () => {
      while (this.pending && !this.disposed) {
        const update = this.pending;
        await this.reconnect(update.settings);
        if (this.pending === update) this.pending = undefined;
        this.services.emit({ type: "settings_applied" });
      }
    }).catch(reason => {
      this.applyFailed = true;
      this.services.emit({ type: "extension_error", error: `Settings saved, but this session could not apply them: ${reason instanceof Error ? reason.message : String(reason)}. Save again to retry.` });
    }).finally(() => {
      this.applying = undefined;
      this.services.emit({ type: "settings_pending" });
    });
  }

  observe(event: RpcEvent) {
    if (event.type === "settings_pending" && typeof event.pending === "boolean") this.daemonPending = event.pending;
    if (event.type === "disconnected") this.daemonPending = false;
  }

  afterEvent(event: RpcEvent) {
    if (["agent_settled", "auto_compaction_end", "queue_update"].includes(event.type)) this.applyPending();
  }

  async runCommand<T>(command: () => Promise<T>): Promise<T> {
    if (this.applying) await this.applying;
    this.activeCommands += 1;
    try { return await command(); }
    finally { this.activeCommands -= 1; this.applyPending(); }
  }

  async dispose() {
    this.disposed = true;
    this.pending = undefined;
    await this.applying;
  }

  async load() {
    const settings = await withClientSettings(await this.services.invoke<AppSettings>("load_app_settings"));
    await saveClientSettings(settings);
    return settings;
  }

  async loadHost() {
    const { hostId } = this.services.connection.target();
    if (hostId === "local") return this.services.invoke<AppSettings>("load_app_settings");
    try { return await this.services.invoke<AppSettings>("load_host_settings", { hostId }); }
    catch (reason) {
      if (String(reason).includes("Command is not available on the daemon: load_host_settings")) throw new Error("The connected or selected remote Piop daemon is older than this client. Update the daemon to access remote settings.");
      throw reason;
    }
  }

  async saveHost(settings: AppSettings, agentsChanged = false) {
    const { hostId } = this.services.connection.target();
    try { return await this.services.invoke<SettingsChange>("save_host_settings", { hostId, settings, agentsChanged }); }
    catch (reason) {
      if (String(reason).includes("Command is not available on the daemon: save_host_settings")) throw new Error("The connected or selected remote Piop daemon needs updating before it can save remote settings.");
      throw reason;
    }
  }

  private selectConfiguredHost(settings: AppSettings, resetDefaults: boolean) {
    const { hostId } = this.services.connection.target();
    if (hostId !== "local" && !settings.hosts.some(host => host.id === hostId)) this.services.connection.resetToLocal(resetDefaults);
  }

  async reconnect(settings: AppSettings) {
    await this.services.connection.disconnect();
    this.selectConfiguredHost(settings, true);
    try { await this.services.connection.connect(); }
    catch (reason) { this.services.emit({ type: "disconnected" }); throw reason; }
  }

  save(settings: AppSettings, reconnect = true, agentHostId?: string) {
    const save = () => this.saveTransaction(settings, reconnect, agentHostId);
    const result = this.saveLifecycle.then(save, save);
    this.saveLifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async saveTransaction(settings: AppSettings, reconnect: boolean, agentHostId?: string) {
    const shortcutError = keybindingsError(settings.keybindings);
    if (shortcutError) throw new Error(shortcutError);
    const previous = await this.services.invoke<AppSettings>("load_app_settings");
    const connection = this.services.connection.target();
    const daemonSettings = preserveDaemonPreferences(settings, previous);
    const daemonChanged = JSON.stringify(daemonSettings) !== JSON.stringify(previous) || Boolean(agentHostId);
    const change = daemonChanged ? await this.services.invoke<SettingsChange>("save_app_settings", { settings: daemonSettings, agentHostId }) : { settings: previous };
    await saveClientSettings(settings);
    change.settings = await withClientSettings(change.settings);
    if (!reconnect || !daemonChanged) return change;
    try {
      this.selectConfiguredHost(settings, false);
      await this.services.connection.disconnect();
      await this.services.connection.connect();
    } catch (reason) {
      await this.services.invoke<void>("save_app_settings", { settings: previous });
      this.services.connection.select(connection);
      try { await this.services.connection.disconnect(); await this.services.connection.connect(); } catch { }
      throw reason;
    }
    return change;
  }
}
