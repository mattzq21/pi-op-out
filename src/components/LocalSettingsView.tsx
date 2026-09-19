import { useCallback, useEffect, useState } from "react";
import { decodeAgentValue, encodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "../lib/agentProtocol";
import { NativeTransport } from "../lib/nativeTransport";
import { isMobile, listen } from "../lib/platform";
import type { AgentConfig, AppSettings, DefinedAgentsCapability, Model, SessionSummary } from "../types";
import { SettingsView } from "./SettingsView";

interface Props {
  settings: AppSettings;
  pendingSettingsCount: number;
  sessions: SessionSummary[];
  onSave: (settings: AppSettings, config?: AgentConfig, previousConfig?: AgentConfig) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
}

export function LocalSettingsView(props: Props) {
  const [target, setTarget] = useState("client");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generation, setGeneration] = useState(0);
  const changeDirty = useCallback((value: boolean) => { setDirty(value); props.onDirtyChange(value); }, [props.onDirtyChange]);
  const label = target === "client" ? "This client" : target === "local" ? isMobile ? "Connected daemon" : "Local daemon" : props.settings.hosts.find((host) => host.id === target)?.name ?? target;
  return <div className="settings-workspace">
    <div className="settings-target"><label className="field"><span>Settings for</span><select aria-label="Settings for" value={target} disabled={dirty || saving} onChange={(event) => setTarget(event.target.value)}>
      <option value="client">This client</option>
      <optgroup label="Daemons"><option value="local">{isMobile ? "Connected daemon" : "Local daemon"}</option>{props.settings.hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</optgroup>
    </select></label>{dirty && <span>Save your changes before switching, or <button disabled={saving} onClick={() => { changeDirty(false); setGeneration((value) => value + 1); }}>discard changes</button>.</span>}</div>
    <DaemonSettingsEditor key={`${target}:${generation}`} {...props} target={target} label={label} onDirtyChange={changeDirty} onSavingChange={setSaving} />
  </div>;
}

function DaemonSettingsEditor({ settings, pendingSettingsCount, sessions, onSave, onDirtyChange, onSavingChange, target, label }: Props & { target: string; label: string }) {
  const hostId = target === "client" ? "local" : target;
  const [hostSettings, setHostSettings] = useState<AppSettings>();
  const [resources, setResources] = useState<{ config: AgentConfig; models: Model[]; levels: string[] }>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const listeners = [
      listen<{ hostId: string }>("pi://provider-auth-changed", ({ payload }) => { if (!cancelled && payload.hostId === hostId) setRevision((value) => value + 1); }),
      listen("pi://settings-changed", () => { if (!cancelled && hostId === "local") setRevision((value) => value + 1); }),
    ];
    return () => { cancelled = true; for (const listener of listeners) void listener.then((stop) => stop()); };
  }, [hostId]);
  useEffect(() => {
    if (target === "client") return;
    let cancelled = false;
    const reader = new NativeTransport({ hostId, cwd: "~" });
    let config: AgentConfig | undefined;
    const unsubscribe = reader.subscribe((event) => {
      if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== DEFINED_AGENTS_STATUS_KEY || typeof event.statusText !== "string" || !event.statusText.startsWith("json:")) return;
      try { config = decodeAgentValue<DefinedAgentsCapability>(event.statusText.slice(5)).config; } catch { config = undefined; }
    });
    setError(undefined);
    void (async () => {
      try {
        const loaded = await reader.loadHostSettings();
        if (cancelled) return;
        setHostSettings(loaded);
        await reader.connect(undefined, undefined, undefined, undefined, true);
        if (cancelled) return;
        const [models, levels] = await Promise.all([
          reader.command<{ models: Model[] }>({ type: "get_available_models" }),
          reader.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
        ]);
        if (!config) throw new Error("Agent definitions are unavailable");
        if (!cancelled) setResources({ config, models: models.models, levels: levels.levels });
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { unsubscribe(); await reader.dispose().catch(() => undefined); }
    })();
    return () => { cancelled = true; unsubscribe(); void reader.dispose().catch(() => undefined); };
  }, [hostId, target, revision]);
  const current = target === "client" || hostId === "local" ? settings : hostSettings;
  const save = async (next: AppSettings, config?: AgentConfig) => {
    if (target === "client" || hostId === "local") await onSave(next, config, resources?.config);
    else {
      const writer = new NativeTransport({ hostId, cwd: "~" });
      let agentsSaved = false;
      const writeAgents = async (value: AgentConfig) => { await writer.command({ type: "prompt", message: `/pi-define-agents-config ${encodeAgentValue(value)}` }); };
      try {
        if (config) { await writer.connect(undefined, undefined, undefined, undefined, true); await writeAgents(config); agentsSaved = true; }
        const change = await writer.saveHostSettings(next, Boolean(config));
        setHostSettings(change.settings);
      } catch (reason) {
        if (agentsSaved && resources?.config) {
          try { await writeAgents(resources.config); }
          catch { throw new Error(`Settings could not be saved and agent definitions could not be restored: ${String(reason)}`); }
        }
        throw reason;
      } finally { await writer.dispose().catch(() => undefined); }
    }
    if (config) setResources((value) => value ? { ...value, config } : value);
  };
  return <>{error && <p role="alert">Could not load {label}: {error} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}{current ? <SettingsView onSavingChange={onSavingChange} scope={target === "client" ? "client" : "daemon"} daemonLabel={label} providerHostId={hostId} providerHosts={settings.hosts} settings={current} pendingSettingsCount={hostId === "local" ? pendingSettingsCount : 0} sessions={sessions.filter((session) => (session.hostId ?? "local") === hostId).map((session) => ({ ...session, hostId: "local" }))} agentConfig={target === "client" ? undefined : resources?.config} models={resources?.models} thinkingLevels={resources?.levels} onDirtyChange={onDirtyChange} onSave={save} /> : !error && <p role="status">Loading {label} settings…</p>}</>;
}
