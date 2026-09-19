import { useEffect, useState } from "react";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "../lib/agentProtocol";
import { NativeTransport } from "../lib/nativeTransport";
import { listen } from "../lib/platform";
import type { AgentConfig, AppSettings, DefinedAgentsCapability, Model, SessionSummary } from "../types";
import { SettingsView } from "./SettingsView";

export function LocalSettingsView({ settings, pendingSettingsCount, sessions, onSave, onDirtyChange }: {
  settings: AppSettings;
  pendingSettingsCount: number;
  sessions: SessionSummary[];
  onSave: (settings: AppSettings, config?: AgentConfig, previousConfig?: AgentConfig) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [resources, setResources] = useState<{ config: AgentConfig; models: Model[]; levels: string[] }>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const listeners = [
      listen<{ hostId: string }>("pi://provider-auth-changed", ({ payload }) => { if (!cancelled && payload.hostId === "local") setRevision((value) => value + 1); }),
      listen("pi://settings-changed", () => { if (!cancelled) setRevision((value) => value + 1); }),
    ];
    return () => { cancelled = true; for (const listener of listeners) void listener.then((stop) => stop()); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const reader = new NativeTransport({ hostId: "local", cwd: "~" });
    let config: AgentConfig | undefined;
    const unsubscribe = reader.subscribe((event) => {
      if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== DEFINED_AGENTS_STATUS_KEY || typeof event.statusText !== "string" || !event.statusText.startsWith("json:")) return;
      try { config = decodeAgentValue<DefinedAgentsCapability>(event.statusText.slice(5)).config; } catch { config = undefined; }
    });
    setError(undefined);
    void (async () => {
      try {
        await reader.connect(undefined, undefined, undefined, undefined, true);
        if (cancelled) return;
        const [models, levels] = await Promise.all([
          reader.command<{ models: Model[] }>({ type: "get_available_models" }),
          reader.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
        ]);
        if (!config) throw new Error("Local agent definitions are unavailable");
        if (!cancelled) setResources({ config, models: models.models, levels: levels.levels });
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { unsubscribe(); await reader.dispose().catch(() => undefined); }
    })();
    return () => { cancelled = true; unsubscribe(); };
  }, [revision]);
  return <>{error && <p role="alert">Could not load local agents and models: {error} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}<SettingsView providerHostId="local" settings={settings} pendingSettingsCount={pendingSettingsCount} sessions={sessions} agentConfig={resources?.config} models={resources?.models} thinkingLevels={resources?.levels} onDirtyChange={onDirtyChange} onSave={async (next, config) => {
    await onSave(next, config, resources?.config);
    if (config) setResources((current) => current ? { ...current, config } : current);
  }} /></>;
}
