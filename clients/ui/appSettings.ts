import { z } from "zod";
import { settingsChangeSchema } from "./lib/responseSchemas";
import { required } from "./lib/required";
import type { Accessor } from "solid-js";
import { createSignal, onCleanup } from "solid-js";
import { saveClientSettings,withClientSettings } from "./lib/clientSettings";
import { agentConfigChangeSchema } from "./lib/agentSchemas";
import { restoreAgentConfiguration, saveAgentConfiguration } from "./lib/agentConfiguration";
import { applyClientPreferences, clientPreferences, ClientPreferenceConflictError, mergeClientPreferences, SettingsSaveError } from "./lib/clientPreferenceMerge";
import { ConversationChangedError } from "./lib/conversationChanged";
import { observeModelReports, refreshHostModels } from "./lib/modelReports";
import { createHostModelVisibility } from "./lib/hostModelVisibility";
import { clearDraftCatalogs } from "./lib/draftRuntime";
import { NativeTransport } from "./lib/nativeTransport";
import { listen } from "./lib/platform";
import type { DebugFeature } from "./lib/debugFeatures";
import { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { SettingsPublication } from "./lib/settingsPublication";
import { createDependencyEffect,createRef } from "./lib/solid";
import { useChatSession } from "./lib/useChatSession";
import { keybindingsError } from "./lib/keybindings";
import type { AgentConfig,AppSettings,SettingsChange } from "./types";

export function createAppSettings({ transport, runtimePool, chatSession, addNotice, preloadChat }: { transport: Accessor<NativeTransport>; runtimePool: Accessor<SessionRuntimePool>; chatSession: Accessor<ReturnType<typeof useChatSession>>; addNotice: (notice: { title: string; message: string }) => void; preloadChat: () => void }) {

  const [settings, setSettings] = createSignal<AppSettings>();
  const runtimeSettings = createRef<AppSettings | undefined>(undefined);
  const publications = new SettingsPublication();
  let latestChange: SettingsChange | undefined;
  let warningKey = "";

  const reportWarnings = (change: SettingsChange) => {
    const key = JSON.stringify([change.source, change.revision, change.warnings, change.synchronizationPending]);

    if (key === warningKey) return;
    warningKey = key;

    if (change.warnings?.length) addNotice({ title: "Settings synchronization pending", message: change.warnings.join("\n") });
  };

  const applyRuntimeSettings = (next: AppSettings) => {
    const previous = runtimeSettings.current;
    runtimeSettings.current = next;

    if (previous) runtimePool().queueSettingsChange(previous, next);
  };

  const settingsSavePending = createRef(false);
  const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [debugModeSaving, setDebugModeSaving] = createSignal(false);
  const debugModePending = createRef(false);
  const [settingsDirty, setSettingsDirty] = createSignal(false);

  const publishSettingsChange = (change: SettingsChange) => {
    if (!publications.accept(change)) return;
    latestChange = change;
    setSettings(change.settings);
    applyRuntimeSettings(change.settings);
    reportWarnings(change);
  };

  const publishPreferences = (baseline: AppSettings, committed: AppSettings) => setSettings(current => {
    if (!current) return current;
    const merged = mergeClientPreferences(clientPreferences(current), clientPreferences(baseline), clientPreferences(committed));

    if (committed.clientSettingsDurabilityError) addNotice({ title: "Client preferences need a save retry", message: `Preferences were published, but disk durability is unconfirmed: ${committed.clientSettingsDurabilityError}. Open client settings and retry saving.` });

    return merged.conflicts.length ? current : { ...applyClientPreferences(current, merged.preferences), clientSettingsRevision: committed.clientSettingsRevision, clientSettingsDurabilityError: committed.clientSettingsDurabilityError };
  });

  const publishConflict = (reason: ClientPreferenceConflictError) => {
    const latest = reason.latest;

    if (latest) setSettings(current => current ? applyClientPreferences(current, clientPreferences(latest)) : current);
  };

  const modelVisibility = createHostModelVisibility(settings, addNotice, async (next, baseline) => {
    const change = await transport().saveSettings(next, false, undefined, "daemon", baseline);
    publishSettingsChange(change);

    return change;
  });
  const recordModels = (hostId: string, ids: string[]) => modelVisibility.recordSeen(hostId, ids);
  onCleanup(observeModelReports(recordModels));
  createDependencyEffect(() => { recordModels(transport().currentHostId(), chatSession().models.map(model => `${model.provider}/${model.id}`)); }, () => [chatSession().models, transport()]);
  createDependencyEffect(() => {
    let revision = 0; let pendingSettings: AppSettings | undefined;

    const update = (change: SettingsChange) => {
      if (!publications.accept(change)) return;
      latestChange = change;
      const publication = publications.generation();
      const value = change.settings;
      pendingSettings = value; const current = ++revision;
      void withClientSettings(value).then(next => {
        if (current !== revision || publication !== publications.generation()) return;
        pendingSettings = undefined; applyRuntimeSettings(next); setSettings(next);
        reportWarnings(change);
      }).catch(reason => addNotice({ title: "Could not load client preferences", message: reason instanceof Error ? reason.message : String(reason) }));
    };

    const pending = listen("pi://settings-changed", ({ payload }) => {
      clearDraftCatalogs();
      update(payload);
    }, settingsChangeSchema);

    const catalogListeners = ["pi://host-settings-changed", "pi://daemon-restarting"].map(event => listen(event, clearDraftCatalogs, z.unknown()));

    const authPending = listen("pi://provider-auth-changed", ({ payload }) => {
      clearDraftCatalogs();
      void refreshHostModels(payload.hostId).catch(reason => addNotice({ title: "Could not refresh model list", message: reason instanceof Error ? reason.message : String(reason) }));
    }, z.object({ hostId: z.string() }));

    const clientPending = listen("pi://client-settings-changed", () => { const current = pendingSettings ?? settings();

    if (current) update({ ...latestChange, settings: current }); }, z.unknown());

    return () => { revision++; clearDraftCatalogs(); void authPending.then(unlisten => unlisten()); void pending.then((unlisten) => unlisten()); void clientPending.then((unlisten) => unlisten());

      for (const listener of catalogListeners) void listener.then(unlisten => unlisten()); };
  }, () => [applyRuntimeSettings]);

  const loadSettings = async () => { const owner = transport(); const request = owner.loadSettingsChange(); preloadChat(); const change = await request;

    if (transport() !== owner) throw new ConversationChangedError();

    if (!publications.accept(change)) {
      const publication = required(latestChange);
      const latest = await withClientSettings(publication.settings);

      if (latestChange === publication) { applyRuntimeSettings(latest); setSettings(latest); reportWarnings(publication); }

      return latest;
    }

    latestChange = change;
    applyRuntimeSettings(change.settings); setSettings(change.settings);
    reportWarnings(change);

    return change.settings; };

  const saveSettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig, baseline?: AppSettings, scope: "all" | "client" | "daemon" = "all") => {
    if (settingsSavePending.current || debugModePending.current) throw new Error("Wait for the current settings save to finish");
    settingsSavePending.current = true; setSettingsSaving(true);

    try { await applySettings(value, nextConfig, previousConfig, baseline, scope); } finally { settingsSavePending.current = false; setSettingsSaving(false); }
  };

  const applySettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig, baseline?: AppSettings, scope: "all" | "client" | "daemon" = "all") => { const capturedTransport = transport();
    required(settings());
    const editingBaseline = required(baseline);
    const next = value; const agentHostId = nextConfig ? "local" : undefined;

    const writeAgents = async (configuration: AgentConfig) => {
      const writer = new NativeTransport({ cwd: "~", hostId: "local" });

      try {
        await writer.connect();
        const change = await writer.command({ type: "configure_agents", configuration }, agentConfigChangeSchema);
        change.warnings?.forEach(message => addNotice({ title: "Agent definitions saved with a warning", message }));

        return change.revision;
      } finally { await writer.dispose().catch(() => undefined); }
    };

    let restoreAgents: (() => Promise<void>) | undefined;
    let savedChange: SettingsChange;

    // Client preferences stay on this device, so they save without the host and also while it is unreachable.
    if (scope === "client" && !nextConfig) {
      const shortcutError = keybindingsError(next.keybindings);

      if (shortcutError) throw new Error(shortcutError);

      try { publishPreferences(editingBaseline, await saveClientSettings(next, editingBaseline)); }
      catch (reason) { if (reason instanceof ClientPreferenceConflictError) publishConflict(reason); throw reason; }

      return;
    }

    try {
      if (nextConfig) restoreAgents = await saveAgentConfiguration(nextConfig, previousConfig, writeAgents);

      savedChange = await capturedTransport.saveSettings(next, false, agentHostId, scope, editingBaseline);
    } catch (reason) {
      if (reason instanceof ClientPreferenceConflictError) publishConflict(reason);

      if (reason instanceof SettingsSaveError) {
        publishSettingsChange(reason.committedChange);
        addNotice({ title: "Settings partially saved", message: reason.message });
        throw reason;
      }

      await restoreAgentConfiguration(restoreAgents, (reason instanceof Error ? reason.message : String(reason)));

      throw reason;
    }

    publishSettingsChange(savedChange);
  };

  const toggleDebugMode = () => {
    if (!settings() || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const baseline = required(settings());
    const next = { ...baseline, debugMode: !baseline.debugMode };
    void saveClientSettings(next, baseline).then(committed => publishPreferences(baseline, committed)).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  };

  const toggleDebugFeature = (feature: DebugFeature) => {
    if (!settings() || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const baseline = required(settings());
    const off = baseline.debugFeaturesOff ?? [];
    const next = { ...baseline, debugFeaturesOff: off.includes(feature) ? off.filter(item => item !== feature) : [...off, feature] };
    void saveClientSettings(next, baseline).then(committed => publishPreferences(baseline, committed)).catch((reason) => addNotice({ title: "Could not change debug features", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  };

 return { modelVisibility, settings, setSettings, runtimeSettings, applyRuntimeSettings, settingsSavePending, settingsSaving, setSettingsSaving, debugModeSaving, setDebugModeSaving, debugModePending, settingsDirty, setSettingsDirty, loadSettings, saveSettings, applySettings, toggleDebugMode, toggleDebugFeature };
}
