import { createSignal, type Accessor } from "solid-js";
import { encodeAgentValue } from "./lib/agentProtocol";
import { withClientSettings } from "./lib/clientSettings";
import { recordSeenModels } from "./lib/modelVisibility";
import { NativeTransport } from "./lib/nativeTransport";
import { listen } from "./lib/platform";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { createDependencyEffect, createRef } from "./lib/solid";
import type { AgentConfig, AppSettings, Model, SettingsChange } from "./types";

type SettingsContext = {
  transport: Accessor<NativeTransport>;
  runtimePool: Accessor<SessionRuntimePool>;
  availableModels: Accessor<Model[]>;
  addNotice: (notice: { title: string; message: string }) => void;
};

export function createAppSettings({ transport, runtimePool, availableModels, addNotice }: SettingsContext) {
  const [settings, setSettings] = createSignal<AppSettings>();
  const runtimeSettings = createRef<AppSettings | undefined>(undefined);
  const applyRuntimeSettings = (next: AppSettings) => {
    const previous = runtimeSettings.current;
    runtimeSettings.current = next;
    if (previous) runtimePool().queueSettingsChange(previous, next);
  };
  const settingsSavePending = createRef(false); const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [debugModeSaving, setDebugModeSaving] = createSignal(false);
  const debugModePending = createRef(false);
  const [settingsDirty, setSettingsDirty] = createSignal(false);
  createDependencyEffect(() => {
    let revision = 0;
    const update = (value: AppSettings) => {
      const current = ++revision;
      void withClientSettings(value).then(next => {
        if (current !== revision) return;
        applyRuntimeSettings(next); setSettings(next);
      }).catch(reason => addNotice({ title: "Could not load client preferences", message: String(reason) }));
    };
    const pending = listen<SettingsChange>("pi://settings-changed", ({ payload }) => {
      update(payload.settings);
    });
    const clientPending = listen("pi://client-settings-changed", () => { const current = settings(); if (current) update(current); });
    return () => { revision++; void pending.then((unlisten) => unlisten()); void clientPending.then((unlisten) => unlisten()); };
  }, () => [applyRuntimeSettings]);
  createDependencyEffect(() => { const capturedSettings = settings(); const models = availableModels(); const capturedTransport = transport();
    if (!capturedSettings || models.length === 0 || settingsSavePending.current) return;
    const next = recordSeenModels((capturedSettings)!, models.map((model) => `${model.provider}/${model.id}`));
    if (!next) return;
    void capturedTransport.saveSettings(next, false).then((change) => { if (change?.settings) setSettings(change.settings); }).catch(() => undefined);
  }, () => [availableModels(), settings(), transport()]);
  createDependencyEffect(() => {
    const capturedSettingsDirty = settingsDirty();
 if (!capturedSettingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, () => [settingsDirty()]);
  const saveSettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig) => {
    if (settingsSavePending.current || debugModePending.current) throw new Error("Wait for the current settings save to finish");
    settingsSavePending.current = true; setSettingsSaving(true);
    try { await applySettings(value, nextConfig, previousConfig); } finally { settingsSavePending.current = false; setSettingsSaving(false); }
  };
  const applySettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig) => { const capturedSettings = settings(); const capturedTransport = transport();
    if (!capturedSettings) throw new Error("Settings are still loading");
    const next = value;
    const agentHostId = nextConfig ? "local" : undefined;
    const writeAgents = async (configuration: AgentConfig) => {
      const writer = new NativeTransport({ cwd: "~", hostId: "local" });
      try {
        await writer.connect(undefined, undefined, undefined, undefined, true);
        await writer.command({ type: "prompt", message: `/pi-define-agents-config ${encodeAgentValue(configuration)}` });
      } finally { await writer.dispose(); }
    };
    let agentsSaved = false;
    let savedChange: SettingsChange;
    try {
      if (nextConfig) { await writeAgents(nextConfig); agentsSaved = true; }
      savedChange = await capturedTransport.saveSettings(next, false, agentHostId);
    } catch (reason) {
      if (agentsSaved && previousConfig) {
        try { await writeAgents(previousConfig); }
        catch { throw new Error(`Settings could not be saved, and the agent definitions could not be restored: ${reason instanceof Error ? reason.message : String(reason)}`); }
      }
      throw reason;
    }
    setSettings(savedChange.settings);
    applyRuntimeSettings(savedChange.settings);
  };
  const toggleDebugMode = () => {
    if (!settings() || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const next = { ...(settings())!, debugMode: !(settings())!.debugMode };
    void transport().saveSettings(next, false).then(() => { applyRuntimeSettings(next); setSettings(next); }).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  };

  const load = async (owner: NativeTransport) => {
    const value = await owner.loadSettings();
    if (transport() !== owner) throw new Error("Conversation changed");
    applyRuntimeSettings(value);
    setSettings(value);
    return value;
  };
  const canLeave = (view: "chat" | "settings") => view !== "settings" || !settingsDirty() || window.confirm("Discard unsaved settings changes?");
  return { settings, settingsSaving, debugModeSaving, settingsDirty, setSettingsDirty, saveSettings, toggleDebugMode, load, canLeave };
}
export type AppSettingsController = ReturnType<typeof createAppSettings>;
