import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { decodeAgentValue, encodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "../lib/agentProtocol";
import { NativeTransport } from "../lib/nativeTransport";
import { isMobile, listen } from "../lib/platform";
import type { AgentConfig, AppSettings, DefinedAgentsCapability, Model, SessionSummary } from "../types";
import { SettingsView, sections, clientSections, type Section } from "./SettingsView";

interface Props {
  settings: AppSettings;
  pendingSettingsCount: number;
  sessions: SessionSummary[];
  onSave: (settings: AppSettings, config?: AgentConfig, previousConfig?: AgentConfig) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  selectedSection?: Section;
}

export function LocalSettingsView(props: Props) {
  const [target, setTarget] = useState("client");
  const [selectedSection, setSelectedSection] = useState<Section>("keybinds");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generation, setGeneration] = useState(0);
  const changeDirty = useCallback((value: boolean) => { setDirty(value); props.onDirtyChange(value); }, [props.onDirtyChange]);
  const label = target === "client" ? "This client" : target === "local" ? isMobile ? "Connected daemon" : "Local daemon" : props.settings.hosts.find((host) => host.id === target)?.name ?? target;
  return <div className="settings-workspace">
    <nav className="settings-nav settings-machine-nav" aria-label="Settings">
      <div className="settings-nav-group"><p className="eyebrow">This client</p>{sections.filter((item) => clientSections.has(item.id)).map((item) => <button key={item.id} disabled={target !== "client" && (dirty || saving)} className={target === "client" && selectedSection === item.id ? "active" : ""} aria-current={target === "client" && selectedSection === item.id ? "page" : undefined} onClick={() => { setTarget("client"); setSelectedSection(item.id); }}><item.icon size={16} /><span>{item.label}</span></button>)}</div>
      <div className="settings-nav-group"><p className="eyebrow">Daemons</p>{[{ id: "local", name: isMobile ? "Connected daemon" : "This computer" }, ...props.settings.hosts].map((host) => <div key={host.id}><button className={target === host.id ? "active" : ""} disabled={target !== host.id && (dirty || saving)} aria-expanded={target === host.id} onClick={() => { if (target !== host.id) { setTarget(host.id); setSelectedSection("general"); } }}><Monitor size={16} /><span>{host.name}</span></button>{target === host.id && <div className="settings-daemon-tabs">{sections.filter((item) => !clientSections.has(item.id)).map((item) => <button key={item.id} className={selectedSection === item.id ? "active" : ""} aria-current={selectedSection === item.id ? "page" : undefined} onClick={() => setSelectedSection(item.id)}><item.icon size={16} /><span>{item.label}</span></button>)}</div>}</div>)}</div>
      {dirty && <p className="settings-switch-hint">Save before switching computers, or <button disabled={saving} onClick={() => { changeDirty(false); setGeneration((value) => value + 1); }}>discard changes</button>.</p>}
    </nav>
    <div className="settings-editor-content"><DaemonSettingsEditor key={`${target}:${generation}`} {...props} target={target} label={label} selectedSection={selectedSection} onDirtyChange={changeDirty} onSavingChange={setSaving} /></div>
  </div>;
}

function DaemonSettingsEditor({ settings, pendingSettingsCount, sessions, onSave, onDirtyChange, onSavingChange, selectedSection, target, label }: Props & { target: string; label: string }) {
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
      try {
        config = decodeAgentValue<DefinedAgentsCapability>(event.statusText.slice(5)).config;
        if (!cancelled && config) {
          const discovered = config;
          setResources((current) => ({ config: discovered, models: current?.models ?? [], levels: current?.levels ?? [] }));
        }
      } catch { config = undefined; }
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
  return <>{error && <p role="alert">Could not load {label}: {error} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}{current ? <SettingsView embedded selectedSection={selectedSection} resourceError={error} onSavingChange={onSavingChange} scope={target === "client" ? "client" : "daemon"} daemonLabel={label} providerHostId={hostId} providerHosts={settings.hosts} settings={current} pendingSettingsCount={hostId === "local" ? pendingSettingsCount : 0} sessions={sessions.filter((session) => (session.hostId ?? "local") === hostId).map((session) => ({ ...session, hostId: "local" }))} agentConfig={target === "client" ? undefined : resources?.config} models={resources?.models} thinkingLevels={resources?.levels} onDirtyChange={onDirtyChange} onSave={save} /> : !error && <p role="status">Loading {label} settings…</p>}</>;
}
