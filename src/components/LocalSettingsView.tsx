import { Key, Rerun } from "@solid-primitives/keyed";
import { createMemo, createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createDependencyEffect } from "../lib/solid";

import { Monitor } from "lucide-solid";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY, encodeAgentValue } from "../lib/agentProtocol";
import { NativeTransport } from "../lib/nativeTransport";
import { isMobile, listen } from "../lib/platform";
import type { AgentConfig, AppSettings, DefinedAgentsCapability, Model, SessionSummary } from "../types";
import { clientSections, sections, SettingsView, type Section } from "./SettingsView";

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
  const [target, setTarget] = createSignal("client");
  const [selectedSection, setSelectedSection] = createSignal<Section>("keybinds");
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [generation, setGeneration] = createSignal(0);
  const changeDirty = (value: boolean) => { setDirty(value); props.onDirtyChange(value); };
  const label = createMemo(() => (target() === "client" ? "This client" : target() === "local" ? isMobile ? "Connected daemon" : "Local daemon" : props.settings.hosts.find((host) => host.id === target())?.name ?? target()));
  return <div class="settings-workspace">
    <nav class="settings-nav settings-machine-nav" aria-label="Settings">
      <div class="settings-nav-group"><p class="eyebrow">This client</p>{<Key each={sections.filter((item) => clientSections.has(item.id))} by={(item) => item.id}>{(item, index) => <button  disabled={target() !== "client" && (dirty() || saving())} class={target() === "client" && selectedSection() === item().id ? "active" : ""} aria-current={target() === "client" && selectedSection() === item().id ? "page" : undefined} onClick={() => { setTarget("client"); setSelectedSection(item().id); }}><Dynamic component={item().icon} size={16} /><span>{item().label}</span></button>}</Key>}</div>
      <div class="settings-nav-group"><p class="eyebrow">Daemons</p>{<Key each={[{ id: "local", name: isMobile ? "Connected daemon" : "This computer" }, ...props.settings.hosts]} by={(host) => host.id}>{(host, index) => <div ><button class={target() === host().id ? "active" : ""} disabled={target() !== host().id && (dirty() || saving())} aria-expanded={target() === host().id} onClick={() => { if (target() !== host().id) { setTarget(host().id); setSelectedSection("general"); } }}><Monitor size={16} /><span>{host().name}</span></button>{target() === host().id && <div class="settings-daemon-tabs">{<Key each={sections.filter((item) => !clientSections.has(item.id))} by={(item) => item.id}>{(item, index) => <button  class={selectedSection() === item().id ? "active" : ""} aria-current={selectedSection() === item().id ? "page" : undefined} onClick={() => setSelectedSection(item().id)}><Dynamic component={item().icon} size={16} /><span>{item().label}</span></button>}</Key>}</div>}</div>}</Key>}</div>
      {dirty() && <p class="settings-switch-hint">Save before switching computers, or <button disabled={saving()} onClick={() => { changeDirty(false); setGeneration((value) => value + 1); }}>discard changes</button>.</p>}
    </nav>
    <div class="settings-editor-content"><Rerun on={() => `${target()}:${generation()}`}>{(_key) => <DaemonSettingsEditor  {...props} target={target()} label={label()} selectedSection={selectedSection()} onDirtyChange={changeDirty} onSavingChange={setSaving} />}</Rerun></div>
  </div>;
}

function DaemonSettingsEditor(componentProps: Props & { target: string; label: string }) {
  const hostId = createMemo(() => (componentProps.target === "client" ? "local" : componentProps.target));
  const [hostSettings, setHostSettings] = createSignal<AppSettings>();
  const [resources, setResources] = createSignal<{ config: AgentConfig; models: Model[]; levels: string[] }>();
  const [error, setError] = createSignal<string>();
  const [revision, setRevision] = createSignal(0);
  createDependencyEffect(() => { const capturedHostId = hostId();
    let cancelled = false;
    const listeners = [
      listen<{ hostId: string }>("pi://provider-auth-changed", ({ payload }) => { if (!cancelled && payload.hostId === capturedHostId) setRevision((value) => value + 1); }),
      listen("pi://settings-changed", () => { if (!cancelled && capturedHostId === "local") setRevision((value) => value + 1); }),
      listen<{ hostId: string }>("pi://host-settings-changed", ({ payload }) => { if (!cancelled && payload.hostId === capturedHostId) setRevision((value) => value + 1); }),
    ];
    return () => { cancelled = true; for (const listener of listeners) void listener.then((stop) => stop()); };
  }, () => [hostId()]);
  createDependencyEffect(() => { const capturedHostId = hostId(); const capturedTarget0 = componentProps.target;
    let cancelled = false;
    const reader = new NativeTransport({ hostId: capturedHostId, cwd: "~" });
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
        if (!config && capturedTarget0 !== "client") throw new Error("Agent definitions are unavailable");
        config ??= { agents: [] };
        if (!cancelled) setResources({ config, models: models.models, levels: levels.levels });
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { unsubscribe(); await reader.dispose().catch(() => undefined); }
    })();
    return () => { cancelled = true; unsubscribe(); void reader.dispose().catch(() => undefined); };
  }, () => [hostId(), componentProps.target, revision()]);
  const current = createMemo(() => (componentProps.target === "client" || hostId() === "local" ? componentProps.settings : hostSettings()));
  const save = async (next: AppSettings, config?: AgentConfig) => { const capturedHostId = hostId(); const capturedResources = resources(); const capturedTarget0 = componentProps.target; const capturedOnSave1 = componentProps.onSave;
    if (capturedTarget0 === "client" || capturedHostId === "local") await capturedOnSave1(next, config, capturedResources?.config);
    else {
      const writer = new NativeTransport({ hostId: capturedHostId, cwd: "~" });
      let agentsSaved = false;
      const writeAgents = async (value: AgentConfig) => { await writer.command({ type: "prompt", message: `/pi-define-agents-config ${encodeAgentValue(value)}` }); };
      const restoreAgents = async (reason: unknown) => {
        if (!agentsSaved || !capturedResources?.config) return;
        try { await writeAgents(capturedResources.config); }
        catch { throw new Error(`Settings could not be saved and agent definitions could not be restored: ${String(reason)}`); }
      };
      try {
        if (config) { await writer.connect(undefined, undefined, undefined, undefined, true); await writeAgents(config); agentsSaved = true; }
        const change = await writer.saveHostSettings(next, Boolean(config));
        setHostSettings(change.settings);
      } catch (reason) {
        await restoreAgents(reason);
        throw reason;
      } finally { await writer.dispose().catch(() => undefined); }
    }
    if (config) setResources((value) => value ? { ...value, config } : value);
  };
  return <>{error() && <p role="alert">Could not load {componentProps.label}: {(error())!} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}{current() ? <SettingsView embedded selectedSection={componentProps.selectedSection} resourceError={error()} onSavingChange={componentProps.onSavingChange} scope={componentProps.target === "client" ? "client" : "daemon"} daemonLabel={componentProps.label} providerHostId={hostId()} providerHosts={componentProps.settings.hosts} settings={(current())!} pendingSettingsCount={hostId() === "local" ? componentProps.pendingSettingsCount : 0} sessions={componentProps.sessions.filter((session) => (session.hostId ?? "local") === hostId()).map((session) => ({ ...session, hostId: "local" }))} agentConfig={componentProps.target === "client" ? undefined : resources()?.config} models={resources()?.models} thinkingLevels={resources()?.levels} onDirtyChange={componentProps.onDirtyChange} onSave={save} /> : !error() && <p role="status">Loading {componentProps.label} settings…</p>}</>;
}
