import { z } from "zod";
import { settingsChangeSchema } from "./lib/responseSchemas";
import { required } from "./lib/required";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";
import { saveClientSettings,withClientSettings } from "./lib/clientSettings";
import { agentConfigChangeSchema } from "./lib/agentSchemas";
import { restoreAgentConfiguration, saveAgentConfiguration } from "./lib/agentConfiguration";
import { ConversationChangedError } from "./lib/conversationChanged";
import { recordSeenModels } from "./lib/modelVisibility";
import { NativeTransport } from "./lib/nativeTransport";
import { listen } from "./lib/platform";
import { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { createDependencyEffect,createRef } from "./lib/solid";
import { useChatSession } from "./lib/useChatSession";
import type { AgentConfig,AppSettings,SettingsChange } from "./types";

export function createAppSettings({ transport, runtimePool, chatSession, addNotice, preloadChat }: { transport: Accessor<NativeTransport>; runtimePool: Accessor<SessionRuntimePool>; chatSession: Accessor<ReturnType<typeof useChatSession>>; addNotice: (notice: { title: string; message: string }) => void; preloadChat: () => void }) {

  const [settings, setSettings] = createSignal<AppSettings>();
  const runtimeSettings = createRef<AppSettings | undefined>(undefined);

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

  const reportClientDurability = (saved: AppSettings) => {
    if (saved.clientSettingsDurabilityError) addNotice({ title: "Client preferences need a save retry", message: `Preferences were published, but disk durability is unconfirmed: ${saved.clientSettingsDurabilityError}. Open client settings and retry saving.` });
  };

  createDependencyEffect(() => { const capturedSettings = settings(); const capturedSession = { ...chatSession() };

    if (!capturedSettings || capturedSession.models.length === 0 || settingsSavePending.current) return;
    const next = recordSeenModels((capturedSettings), capturedSession.models.map((model) => `${model.provider}/${model.id}`));

    if (!next) return;
    void saveClientSettings(next).then(saved => {
      setSettings(current => current && (current.clientSettingsRevision === capturedSettings.clientSettingsRevision || current.clientSettingsRevision === saved.clientSettingsRevision) ? { ...current, knownModels: saved.knownModels, hiddenModels: saved.hiddenModels, clientSettingsRevision: saved.clientSettingsRevision, clientSettingsDurabilityError: saved.clientSettingsDurabilityError } : current);
      reportClientDurability(saved);
    }).catch(() => undefined);
  }, () => [chatSession().models, settings(), transport()]);
  createDependencyEffect(() => {
    let revision = 0; let pendingSettings: AppSettings | undefined;

    const update = (value: AppSettings) => {
      pendingSettings = value; const current = ++revision;
      void withClientSettings(value).then(next => {
        if (current !== revision) return;
        pendingSettings = undefined; applyRuntimeSettings(next); setSettings(next);
      }).catch(reason => addNotice({ title: "Could not load client preferences", message: String(reason) }));
    };

    const pending = listen("pi://settings-changed", ({ payload }) => {
      update(payload.settings);
    }, settingsChangeSchema);

    const clientPending = listen("pi://client-settings-changed", () => { const current = pendingSettings ?? settings();

    if (current) update(current); }, z.unknown());

    return () => { revision++; void pending.then((unlisten) => unlisten()); void clientPending.then((unlisten) => unlisten()); };
  }, () => [applyRuntimeSettings]);

  const loadSettings = async () => { const owner = transport(); const request = owner.loadSettings(); preloadChat(); const nextSettings = await request;

    if (transport() !== owner) throw new ConversationChangedError();
    applyRuntimeSettings(nextSettings); setSettings(nextSettings);

    return nextSettings; };

  const saveSettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig, scope: "all" | "client" | "daemon" = "all") => {
    if (settingsSavePending.current || debugModePending.current) throw new Error("Wait for the current settings save to finish");
    settingsSavePending.current = true; setSettingsSaving(true);

    try { await applySettings(value, nextConfig, previousConfig, scope); } finally { settingsSavePending.current = false; setSettingsSaving(false); }
  };

  const applySettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig, scope?: "all" | "client" | "daemon") => { const capturedSettings = settings(); const capturedTransport = transport();

    if (!capturedSettings) throw new Error("Settings are still loading");
    const next = value; const agentHostId = nextConfig ? "local" : undefined;

    const writeAgents = async (configuration: AgentConfig) => {
      const writer = new NativeTransport({ cwd: "~", hostId: "local" });

      try {
        await writer.connect(undefined, undefined, undefined, undefined, true);
        const change = await writer.command({ type: "configure_agents", configuration }, agentConfigChangeSchema);
        change.warnings?.forEach(message => addNotice({ title: "Agent definitions saved with a warning", message }));

        return change.revision;
      } finally { await writer.dispose().catch(() => undefined); }
    };

    let restoreAgents: (() => Promise<void>) | undefined;
    let savedChange: SettingsChange;

    try {
      if (nextConfig) restoreAgents = await saveAgentConfiguration(nextConfig, previousConfig, writeAgents);

      savedChange = await capturedTransport.saveSettings(next, false, agentHostId, scope);
    } catch (reason) {
      await restoreAgentConfiguration(restoreAgents, String(reason));
      throw reason;
    }

    setSettings(savedChange.settings);
    applyRuntimeSettings(savedChange.settings);
    savedChange.warnings?.forEach(warning => addNotice({ title: "Settings save warning", message: warning }));
  };

  const toggleDebugMode = () => {
    if (!settings() || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const next = { ...required((settings())), debugMode: !required((settings())).debugMode };
    void saveClientSettings(next).then(saved => {
      setSettings(current => current && (current.clientSettingsRevision === next.clientSettingsRevision || current.clientSettingsRevision === saved.clientSettingsRevision) ? { ...current, debugMode: saved.debugMode, clientSettingsRevision: saved.clientSettingsRevision, clientSettingsDurabilityError: saved.clientSettingsDurabilityError } : current);
      reportClientDurability(saved);
    }).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  };

 return { settings, setSettings, runtimeSettings, applyRuntimeSettings, settingsSavePending, settingsSaving, setSettingsSaving, debugModeSaving, setDebugModeSaving, debugModePending, settingsDirty, setSettingsDirty, loadSettings, saveSettings, applySettings, toggleDebugMode };
}
