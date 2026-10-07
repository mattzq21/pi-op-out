import { appSettingsSchema, settingsChangeSchema } from "./responseSchemas";
import type { AppSettings, RpcEvent } from "../types";
import { preferences, preserveDaemonPreferences, saveClientSettings, withClientSettings } from "./clientSettings";
import { keybindingsError } from "./keybindings";
import type { NativeCall } from "./nativeCall";

type SettingsTarget = { cwd?: string; sessionPath?: string; sessionId?: string; hostId: string };

type SettingsConnection = {
  target: () => SettingsTarget;
  selectTarget: (target: SettingsTarget) => void;
  resetToLocal: (fresh: boolean) => void;
  disconnect: () => Promise<boolean>;
  connect: () => Promise<void>;
  closed: () => boolean;
  emit: (event: RpcEvent) => void;
};

export class NativeSettings {
  private lifecycle: Promise<void> = Promise.resolve();
  private pending?: { settings: AppSettings };
  private daemonPending = false;
  private applying?: Promise<void>;
  private applyFailed = false;
  private activeCommands = 0;

  constructor(private call: NativeCall, private connection: SettingsConnection) {}

  load() { return withClientSettings(this.call("load_app_settings", undefined, appSettingsSchema), true); }

  async loadHost() {
    const hostId = this.connection.target().hostId;

    if (hostId === "local") return this.call("load_app_settings", undefined, appSettingsSchema);

    try { return await this.call("load_host_settings", { hostId }, appSettingsSchema); }
    catch (reason) {
      if (String(reason).includes("Command is not available on the daemon: load_host_settings")) throw new Error("The connected or selected remote Piop daemon is older than this client. Update the daemon to access remote settings.");
      throw reason;
    }
  }

  async saveHost(settings: AppSettings, agentsChanged = false) {
    const hostId = this.connection.target().hostId;

    try { return await this.call("save_host_settings", { hostId, settings, agentsChanged }, settingsChangeSchema); }
    catch (reason) {
      if (String(reason).includes("Command is not available on the daemon: save_host_settings")) throw new Error("The connected or selected remote Piop daemon needs updating before it can save remote settings.");
      throw reason;
    }
  }

  save(settings: AppSettings, reconnect = true, agentHostId?: string, scope: "all" | "client" | "daemon" = "all") {
    const save = () => this.saveNow(settings, reconnect, agentHostId, scope);
    const result = this.lifecycle.then(save, save);
    this.lifecycle = result.then(() => undefined, () => undefined);

    return result;
  }

  private async saveNow(settings: AppSettings, reconnect: boolean, agentHostId: string | undefined, scope: "all" | "client" | "daemon") {
    const shortcutError = keybindingsError(settings.keybindings);

    if (shortcutError) throw new Error(shortcutError);
    const previous = await this.call("load_app_settings", undefined, appSettingsSchema);
    const previousClient = await withClientSettings(previous);
    const daemonSettings = scope === "client" ? previous : preserveDaemonPreferences(settings, previous);
    const daemonChanged = JSON.stringify(daemonSettings) !== JSON.stringify(previous) || Boolean(agentHostId);
    const clientChanged = scope !== "daemon" && JSON.stringify(preferences(settings)) !== JSON.stringify(preferences(previousClient));

    const savedClient = clientChanged ? await saveClientSettings(settings) : previousClient;
    let change;

    try { change = daemonChanged ? await this.call("save_app_settings", { settings: daemonSettings, agentHostId }, settingsChangeSchema) : { settings: previous }; }
    catch (reason) {
      await this.restoreClientSettings(previousClient, clientChanged, savedClient.clientSettingsRevision, String(reason));
      throw reason;
    }

    change.settings = { ...change.settings, ...preferences(savedClient), clientSettingsRevision: savedClient.clientSettingsRevision };

    if (reconnect && daemonChanged) await this.reconnectAfterSave(settings);

    return change;
  }

  private async restoreClientSettings(settings: AppSettings, changed: boolean, expectedRevision: string | undefined, reason: string) {
    try { if (changed && expectedRevision) await saveClientSettings(settings, expectedRevision); }
    catch (rollback) { throw new Error(`Settings save failed: ${String(reason)}. Client preferences could not be restored: ${String(rollback)}. Reload settings before retrying.`); }
  }

  private selectAvailableHost(settings: AppSettings, fresh: boolean) {
    const { hostId } = this.connection.target();

    if (hostId !== "local" && !settings.hosts.some(host => host.enabled !== false && host.id === hostId)) this.connection.resetToLocal(fresh);
  }

  private async reconnectAfterSave(settings: AppSettings) {
    try {
      this.selectAvailableHost(settings, false);
      await this.connection.disconnect();
      await this.connection.connect();
    } catch (reason) {
      this.queue(settings, { reconnect: true });
      this.connection.emit({ type: "extension_error", error: `Settings saved, but this session could not reconnect: ${String(reason)}. Reconnect to apply them.` });
    }
  }

  async reconnect(settings: AppSettings) {
    await this.connection.disconnect();
    this.selectAvailableHost(settings, true);

    try { await this.connection.connect(); }
    catch (reason) { this.connection.emit({ type: "disconnected" }); throw reason; }
  }

  hasPending() { return Boolean(this.daemonPending || this.pending || this.applying); }

  queue(settings: AppSettings, changes: { reconnect: boolean }) {
    if (this.connection.closed() || (!this.pending && !changes.reconnect)) return;
    this.pending = { settings: structuredClone(settings) };
    this.applyFailed = false;
    this.connection.emit({ type: "settings_pending" });
    this.applyPending();
  }

  receive(event: RpcEvent) {
    if (event.type === "settings_pending" && (event.pending === true || event.pending === false)) this.daemonPending = event.pending;

    if (event.type === "disconnected") this.daemonPending = false;
  }

  afterEvent(event: RpcEvent) {
    if (["agent_settled", "auto_compaction_end", "queue_update"].includes(event.type)) this.applyPending();
  }

  private applyPending() {
    if (!this.pending || this.applying || this.activeCommands || this.connection.closed() || this.applyFailed) return;
    this.applying = Promise.resolve().then(async () => {
      while (this.pending && !this.connection.closed()) {
        const update = this.pending;
        await this.reconnect(update.settings);

        if (this.pending === update) this.pending = undefined;
        this.connection.emit({ type: "settings_applied" });
      }
    }).catch(reason => {
      this.applyFailed = true;
      this.connection.emit({ type: "extension_error", error: `Settings saved, but this session could not apply them: ${reason instanceof Error ? reason.message : String(reason)}. Save again to retry.` });
    }).finally(() => {
      this.applying = undefined;
      this.connection.emit({ type: "settings_pending" });
    });
  }

  async runCommand<T>(command: () => Promise<T>): Promise<T> {
    if (this.applying) await this.applying;
    this.activeCommands += 1;

    try { return await command(); }
    finally { this.activeCommands -= 1; this.applyPending(); }
  }

  cancelPending() { this.pending = undefined; }
  whenApplied() { return this.applying; }
}
