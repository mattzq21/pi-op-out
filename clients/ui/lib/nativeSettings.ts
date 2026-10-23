import { appSettingsSchema, settingsChangeSchema } from "./responseSchemas";
import type { AppSettings, RpcEvent, SettingsChange } from "../types";
import { preserveDaemonPreferences, saveClientSettings, withClientSettings } from "./clientSettings";
import { keybindingsError } from "./keybindings";
import type { NativeCall } from "./nativeCall";
import { clientPreferences, ClientPreferenceConflictError, SettingsSaveError } from "./clientPreferenceMerge";

import { settingsSnapshot } from "./settingsSnapshots";

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

function needsDaemonSave(settings: AppSettings, previous: AppSettings, agentHostId: string | undefined, scope: string) {
  return scope !== "client" && (Boolean(settings.settingsDurabilityError) || settingsSnapshot(settings) !== settingsSnapshot(previous) || Boolean(agentHostId));
}

function needsClientSave(settings: AppSettings, baseline: AppSettings, previous: AppSettings) {
  return Boolean(settings.clientSettingsDurabilityError ?? previous.clientSettingsDurabilityError) || JSON.stringify(clientPreferences(settings)) !== JSON.stringify(clientPreferences(baseline));
}

function mergeSavedPreferences(change: SettingsChange, committed: AppSettings) {
  change.settings = preserveDaemonPreferences(change.settings, committed);

  if (committed.clientSettingsDurabilityError) change.warnings = [...change.warnings ?? [], `Client preferences were published, but disk durability is unconfirmed: ${committed.clientSettingsDurabilityError}. Retry saving to confirm them.`];
}

export class NativeSettings {
  private lifecycle: Promise<void> = Promise.resolve();
  private pending?: { settings: AppSettings };
  private daemonPending = false;
  private applying?: Promise<void>;
  private applyFailed = false;
  private activeCommands = 0;

  constructor(private call: NativeCall, private connection: SettingsConnection) {}

  private async daemonChange() {
    let change: SettingsChange;

    try { change = await this.call("load_settings_change", undefined, settingsChangeSchema); }
    catch (reason) {
      if (!(reason instanceof Error ? reason.message : String(reason)).includes("Command is not available on the daemon: load_settings_change")) throw reason;
      change = { settings: await this.call("load_app_settings", undefined, appSettingsSchema) };
    }

    return change;
  }

  async loadChange() {
    const change = await this.daemonChange();

    return { ...change, settings: await withClientSettings(change.settings, true) };
  }

  async load() { return (await this.loadChange()).settings; }

  async loadHostChange() {
    const hostId = this.connection.target().hostId;

    try { return await this.call(hostId === "local" ? "load_settings_change" : "load_host_settings_change", { hostId }, settingsChangeSchema); }
    catch (reason) {
      if (!(reason instanceof Error ? reason.message : String(reason)).includes("Command is not available on the daemon: load_")) throw reason;

      return { settings: await this.loadHost() };
    }
  }

  async loadHost() {
    const hostId = this.connection.target().hostId;

    if (hostId === "local") return this.call("load_app_settings", undefined, appSettingsSchema);

    try { return await this.call("load_host_settings", { hostId }, appSettingsSchema); }
    catch (reason) {
      if ((reason instanceof Error ? reason.message : String(reason)).includes("Command is not available on the daemon: load_host_settings")) throw new Error("The connected or selected remote Piop daemon is older than this client. Update the daemon to access remote settings.");
      throw reason;
    }
  }

  async saveHost(settings: AppSettings, agentsChanged = false) {
    const hostId = this.connection.target().hostId;

    try { return await this.call("save_host_settings", { hostId, settings, agentsChanged }, settingsChangeSchema); }
    catch (reason) {
      if ((reason instanceof Error ? reason.message : String(reason)).includes("Command is not available on the daemon: save_host_settings")) throw new Error("The connected or selected remote Piop daemon needs updating before it can save remote settings.");
      throw reason;
    }
  }

  save(settings: AppSettings, reconnect = true, agentHostId?: string, scope: "all" | "client" | "daemon" = "all", baseline?: AppSettings) {
    if (!baseline && scope !== "daemon") return Promise.reject(new Error("An editing baseline is required to save client preferences"));
    const intended = structuredClone(settings);
    const before = structuredClone(baseline ?? settings);
    const save = () => this.saveNow(intended, reconnect, agentHostId, scope, before);
    const result = this.lifecycle.then(save, save);
    this.lifecycle = result.then(() => undefined, () => undefined);

    return result;
  }

  private async saveNow(settings: AppSettings, reconnect: boolean, agentHostId: string | undefined, scope: "all" | "client" | "daemon", baseline: AppSettings) {
    const shortcutError = keybindingsError(settings.keybindings);

    if (shortcutError) throw new Error(shortcutError);
    const previousChange = await this.daemonChange();
    const previous = previousChange.settings;
    const daemonSettings = scope === "client" ? previous : preserveDaemonPreferences(settings, previous);
    const daemonChanged = needsDaemonSave(daemonSettings, previous, agentHostId, scope);
    const change: SettingsChange = daemonChanged ? await this.call("save_app_settings", { settings: daemonSettings, agentHostId }, settingsChangeSchema) : { ...previousChange };
    await this.savePreferences(settings, baseline, change, daemonChanged, scope);

    if (daemonChanged) await this.reloadCommitted(change);

    if (reconnect && daemonChanged) {
      try { await this.reconnect(change.settings); }
      catch (reason) { throw new SettingsSaveError(`Settings were saved, but this session could not reconnect: ${reason instanceof Error ? reason.message : String(reason)}`, change, "reconnect"); }
    }

    return change;
  }

  private async reloadCommitted(change: SettingsChange) {
    try {
      const current = await this.loadChange();

      if (current.revision === undefined) return;
      const newer = current.revision > (change.revision ?? -1);
      const phaseChanged = current.revision === change.revision && (current.phaseRevision ?? 0) > (change.phaseRevision ?? 0);

      if (!newer && !phaseChanged) return;
      const committedRevision = change.committedRevision;
      Object.assign(change, current);
      change.committedRevision = committedRevision;
    } catch (reason) { throw new SettingsSaveError(`Settings were saved, but their current state could not be reloaded: ${(reason instanceof Error ? reason.message : String(reason))}`, change, "reconnect"); }
  }

  private async savePreferences(settings: AppSettings, baseline: AppSettings, change: SettingsChange, daemonChanged: boolean, scope: string) {
    try {
      const previous = await withClientSettings(change.settings);
      const changed = scope !== "daemon" && needsClientSave(settings, baseline, previous);
      const committed = changed ? await saveClientSettings(settings, baseline) : previous;
      mergeSavedPreferences(change, committed);
    } catch (reason) {
      if (!daemonChanged) throw reason;
      change.settings = preserveDaemonPreferences(change.settings, baseline);

      try { change.settings = await withClientSettings(change.settings); } catch { }

      throw new SettingsSaveError(`Daemon settings were saved, but client preferences could not be saved: ${reason instanceof Error ? reason.message : String(reason)}`, change, "client", reason instanceof ClientPreferenceConflictError ? reason : undefined);
    }
  }

  private selectAvailableHost(settings: AppSettings, fresh: boolean) {
    const { hostId } = this.connection.target();

    if (hostId !== "local" && !settings.hosts.some(host => host.enabled !== false && host.id === hostId)) this.connection.resetToLocal(fresh);
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
