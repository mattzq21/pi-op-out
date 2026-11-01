import { localHostLabel } from "../lib/mobileHosts";
import { z } from "zod";
import { required } from "../lib/required";
import { Key, Rerun } from "@solid-primitives/keyed";
import { createMemo, createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createDependencyEffect } from "../lib/solid";

import { ArrowLeft, Monitor } from "lucide-solid";
import { settingsChangeSchema } from "../lib/responseSchemas";
import { AgentsSavedError, moveAgent as moveAgentBetween, saveAgentDefinitions, saveProjectAgents } from "../lib/hostAgents";
import { hostCatalog } from "../lib/draftRuntime";
import { isTemporaryChatCwd, useSessionGroups } from "../lib/sessionGroups";
import { NativeTransport } from "../lib/nativeTransport";
import { settingsResources, type SettingsResources } from "../lib/settingsResources";
import { SettingsPublication } from "../lib/settingsPublication";
import { SettingsSaveError } from "../lib/clientPreferenceMerge";
import { isMobile, listen } from "../lib/platform";
import type { AgentConfig, AppSettings, SessionSummary, SettingsChange, SettingsPublication as Publication } from "../types";
import { visibleClientSections, daemonSections, SettingsView, type Section } from "./SettingsView";

interface Props {
  settings: AppSettings;
  pendingSettingsCount: number;
  sessions: SessionSummary[];
  onSave: (settings: AppSettings, baseline?: AppSettings, scope?: "all" | "client" | "daemon") => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBack: () => void;
  onSavingChange?: (saving: boolean) => void;
  selectedSection?: Section;
}

export function LocalSettingsView(props: Props) {
  const [target, setTarget] = createSignal("client");
  const [selectedSection, setSelectedSection] = createSignal<Section>("keybinds");
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const pendingDurability = new Map<string, string>();

  const preserveHostSettings = (hostId: string, settings: AppSettings, publication?: Publication) => {
    if (!settings.settingsRevision) return settings;
    const key = JSON.stringify([hostId, settings.settingsRevision]);

    if (publication?.durable) pendingDurability.delete(key);
    else if (settings.settingsDurabilityError) pendingDurability.set(key, settings.settingsDurabilityError);
    const pending = pendingDurability.get(key);

    return pending ? { ...settings, settingsDurabilityError: pending } : settings;
  };

  const changeDirty = (value: boolean) => { setDirty(value); props.onDirtyChange(value); };

  const label = createMemo(() => (target() === "client" ? "Client" : target() === "local" ? isMobile ? localHostLabel() : "Daemon" : props.settings.hosts.find((host) => host.id === target())?.name ?? target()));

  return <div class="settings-workspace">
    <nav class="settings-nav settings-host-nav" aria-label="Settings">
      <button class="settings-back" aria-label="Go back" onClick={() => props.onBack()}><ArrowLeft size={16} /><span>Back</span></button>
      <div class="settings-nav-group"><p class="eyebrow">Client</p>{<Key each={visibleClientSections()} by={(item) => item.id}>{(item, _index) => <button  disabled={target() !== "client" && (dirty() || saving())} class={target() === "client" && selectedSection() === item().id ? "active" : ""} aria-current={target() === "client" && selectedSection() === item().id ? "page" : undefined} onClick={() => { setTarget("client"); setSelectedSection(item().id); }}><Dynamic component={item().icon} size={16} /><span>{item().label}</span></button>}</Key>}</div>
      <div class="settings-nav-group"><p class="eyebrow">Daemons</p>{<Key each={[{ id: "local", name: localHostLabel() }, ...props.settings.hosts.filter((host) => host.enabled !== false)]} by={(host) => host.id}>{(host, _index) => <div ><button class={target() === host().id ? "active" : ""} disabled={target() !== host().id && (dirty() || saving())} aria-expanded={target() === host().id} onClick={() => { if (target() !== host().id) { setTarget(host().id); setSelectedSection("general"); } }}><Monitor size={16} /><span>{host().name}</span></button>{target() === host().id && <div class="settings-daemon-tabs">{<Key each={daemonSections(host().id)} by={(item) => item.id}>{(item, _index) => <button  class={[selectedSection() === item().id ? "active" : "", item().parent ? "sub" : ""].filter(Boolean).join(" ")} aria-current={selectedSection() === item().id ? "page" : undefined} onClick={() => setSelectedSection(item().id)}><Dynamic component={item().icon} size={16} /><span>{item().label}</span></button>}</Key>}</div>}</div>}</Key>}</div>
    </nav>
    <div class="settings-editor-content"><Rerun on={() => target()}>{(_key) => <DaemonSettingsEditor  {...props} preserveHostSettings={preserveHostSettings} target={target()} label={label()} selectedSection={selectedSection()} onDirtyChange={changeDirty} onSavingChange={setSaving} />}</Rerun></div>
  </div>;
}

function DaemonSettingsEditor(componentProps: Props & { target: string; label: string; preserveHostSettings: (hostId: string, settings: AppSettings, publication?: Publication) => AppSettings }) {
  const hostId = createMemo(() => (componentProps.target === "client" ? "local" : componentProps.target));
  const [hostSettings, setHostSettings] = createSignal<AppSettings>();
  const [resources, setResources] = createSignal<SettingsResources>();
  const [error, setError] = createSignal<string>();
  const [loadingModels, setLoadingModels] = createSignal<string[]>([]);
  const [saveWarnings, setSaveWarnings] = createSignal<string[]>();
  const [revision, setRevision] = createSignal(0);
  const needsResources = createMemo(() => componentProps.target !== "client");
  const groups = useSessionGroups();
  const projects = createMemo(() => (groups.state?.groups ?? []).flatMap(group => group.cwd && !isTemporaryChatCwd(group.cwd) && (group.hostId ?? "local") === hostId() ? [{ name: group.name, cwd: group.cwd }] : []));
  const [agentScope, setAgentScope] = createSignal<string>();
  const [projectConfig, setProjectConfig] = createSignal<AgentConfig>();
  createDependencyEffect(() => { setProjectConfig(undefined); }, () => [hostId(), agentScope()]);
  createDependencyEffect(() => { const capturedHostId = hostId(); const cwd = agentScope();
    if (!cwd) return;
    let cancelled = false;
    void hostCatalog(capturedHostId, "fresh", cwd).then(({ config }) => { if (!cancelled) setProjectConfig(config); }, reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });

    return () => { cancelled = true; };
  }, () => [hostId(), agentScope(), revision()]);
  const projectAgents = createMemo((): AgentConfig | undefined => {
    const config = projectConfig();

    return config?.project && { revision: config.project.revision, agents: config.agents.filter(agent => agent.project).map(({ project: _project, isDefault: _isDefault, ...agent }) => agent) };
  });

  const publications = new SettingsPublication();

  const receiveChange = (change: SettingsChange, host: string) => {
    if (!publications.accept(change, host)) return;
    setSaveWarnings(change.warnings);
    setHostSettings(componentProps.preserveHostSettings(host, change.settings, change.publication));
  };

  createDependencyEffect(() => { const capturedHostId = hostId();
    let cancelled = false;

    const listeners = [
      listen("pi://provider-auth-changed", ({ payload }) => { if (!cancelled && payload.hostId === capturedHostId) setRevision((value) => value + 1); }, z.object({ hostId: z.string() })),
      listen("pi://settings-changed", ({ payload }) => { if (!cancelled && capturedHostId === "local") { receiveChange(payload, capturedHostId); setRevision((value) => value + 1); } }, settingsChangeSchema),
      listen("pi://host-settings-changed", ({ payload }) => { if (!cancelled && payload.hostId === capturedHostId) { receiveChange(payload, capturedHostId); setRevision((value) => value + 1); } }, settingsChangeSchema.extend({ hostId: z.string() })),
      listen("pi://agent-definitions-changed", ({ payload }) => { if (!cancelled && payload.hostId === capturedHostId) setRevision((value) => value + 1); }, z.object({ hostId: z.string() })),
    ];

    return () => { cancelled = true;

    for (const listener of listeners) void listener.then((stop) => stop()); };
  }, () => [hostId()]);
  createDependencyEffect(() => { const capturedHostId = hostId(); const capturedRevision = revision();
    setError(undefined);
    setLoadingModels([]);

    if (!needsResources()) return;
    let cancelled = false;
    const reader = new NativeTransport({ hostId: capturedHostId, cwd: "~" });
    setLoadingModels([componentProps.label]);

    void (async () => {
      try {
        const loaded = await reader.loadHostSettingsChange();

        if (cancelled) return;
        receiveChange(loaded, capturedHostId);
        const loadedResources = await settingsResources(capturedHostId, capturedRevision !== 0);

        if (cancelled) return;
        const recorded = await reader.loadHostSettingsChange();

        if (cancelled) return;
        receiveChange(recorded, capturedHostId);
        setResources(loadedResources);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally { if (!cancelled) setLoadingModels([]); await reader.dispose().catch(reason => console.error("Could not close the settings reader:", reason)); }
    })();

    return () => { cancelled = true; };
  }, () => [hostId(), componentProps.target, revision(), needsResources()]);
  const current = createMemo(() => (componentProps.target === "client" || hostId() === "local" ? componentProps.settings : hostSettings()));

  const publishSavedAgents = (config?: AgentConfig) => {
    if (config) setResources(value => value ? { ...value, config } : value);
  };

  const moveAgent = async (agent: string, cwd?: string) => {
    const capturedHostId = hostId(); const config = resources()?.config; const scope = agentScope(); const project = projectConfig();

    if (!config?.revision || (scope && !project?.project)) throw new Error("Agent definitions are still loading");

    if (scope && project?.project) {
      const profile = project.agents.find(item => item.name === agent);
      const moved = await moveAgentBetween(capturedHostId, scope, agent, project.project.revision, "global");
      setProjectConfig(current => current && { ...current, agents: current.agents.filter(item => item.name !== agent) });

      if (profile) { const { project: _project, isDefault: _isDefault, ...global } = profile; publishSavedAgents({ ...config, revision: moved.revision, agents: [...config.agents, global] }); }

      return;
    }

    if (!cwd) throw new Error("Choose a project");
    const moved = await moveAgentBetween(capturedHostId, cwd, agent, config.revision, "project");
    publishSavedAgents({ ...config, revision: moved.revision, agents: config.agents.filter(item => item.name !== agent) });
  };

  const publishHostChange = (change: SettingsChange) => receiveChange(change, hostId());

  const saveRemote = async (next: AppSettings, capturedHostId: string) => {
    const writer = new NativeTransport({ hostId: capturedHostId, cwd: "~" });

    try { return await writer.saveHostSettings(next); }
    catch (reason) {
      if (reason instanceof SettingsSaveError) {
        publishHostChange(reason.committedChange);
        setSaveWarnings([...(reason.committedChange.warnings ?? []), reason.message]);
      }

      throw reason;
    } finally { await writer.dispose().catch(() => undefined); }
  };

  const save = async (next: AppSettings, config?: AgentConfig, baseline?: AppSettings) => {
    const capturedHostId = hostId(); const capturedTarget = componentProps.target; const capturedOnSave = componentProps.onSave;
    setSaveWarnings(undefined);
    const agentWarnings: string[] = [];

    const capturedScope = agentScope();

    if (config && capturedScope) {
      const saved = await saveProjectAgents(capturedHostId, capturedScope, { revision: config.revision ?? "missing", agents: config.agents });
      config.revision = saved.revision;
      agentWarnings.push(...saved.warnings);
      const agents = config.agents;
      setProjectConfig(project => project?.project && { ...project, project: { ...project.project, revision: saved.revision }, agents: [...project.agents.filter(agent => !agent.project), ...agents.map(agent => ({ ...agent, project: true }))] });
    } else if (config) {
      const saved = await saveAgentDefinitions(capturedHostId, config);
      config.revision = saved.revision;
      agentWarnings.push(...saved.warnings);
      publishSavedAgents(config);
    }

    try {
      if (capturedTarget === "client" || capturedHostId === "local") await capturedOnSave(next, baseline, capturedTarget === "client" ? "client" : "daemon");
      else publishHostChange(await saveRemote(next, capturedHostId));
    } catch (reason) {
      if (!config || reason instanceof SettingsSaveError) throw reason;
      throw new AgentsSavedError(reason);
    } finally { if (agentWarnings.length) setSaveWarnings(current => [...current ?? [], ...agentWarnings]); }
  };

  const renderSaveWarnings = () => {
    const warnings = saveWarnings();

    return warnings && warnings.length > 0 && <p role="alert">Saved with warnings: {warnings.join(" ")}</p>;
  };

  return <>{renderSaveWarnings()}{error() && <p role="alert">Could not load {componentProps.label}: {(error())} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}{current() ? <SettingsView embedded selectedSection={componentProps.selectedSection} resourceError={error()} onSavingChange={componentProps.onSavingChange} scope={componentProps.target === "client" ? "client" : "daemon"} daemonLabel={componentProps.label} providerHostId={hostId()} providerHosts={componentProps.settings.hosts} settings={required((current()))} pendingSettingsCount={hostId() === "local" ? componentProps.pendingSettingsCount : 0} sessions={componentProps.sessions.filter((session) => (session.hostId ?? "local") === hostId()).map((session) => ({ ...session, hostId: "local" }))} agentConfig={componentProps.target === "client" ? undefined : agentScope() ? projectAgents() : resources()?.config} inheritedAgents={agentScope() ? resources()?.config.agents ?? [] : undefined} agentScopes={projects()} agentScope={agentScope()} onAgentScope={setAgentScope} onMoveAgent={moveAgent} models={resources()?.models} loadingModels={loadingModels()} onDirtyChange={componentProps.onDirtyChange} onSave={save} /> : !error() && <p role="status">Loading {componentProps.label} settings…</p>}</>;
}
