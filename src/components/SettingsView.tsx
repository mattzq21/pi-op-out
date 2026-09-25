import { Key, Rerun } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal, Index, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { accountModelName } from "../lib/providerAccounts";
import { createDependencyEffect, createMemoFields, createRef, type JSXElement } from "../lib/solid";

import { Bot, Check, CircleGauge, CirclePlus, Cpu, HardDrive, Keyboard, PlugZap, RotateCcw, Save, Search, Server, Settings2, ShieldCheck, Trash2, Wrench, Zap } from "lucide-solid";
import { uid } from "../lib/content";
import { defaultKeybindings, keybindDefinitions, shortcutError, shortcutFromEvent, shortcutsConflict, type KeybindAction } from "../lib/keybindings";
import { isMobile } from "../lib/platform";
import type { AgentConfig, AgentProfile, AppSettings, McpServer, Model, RemoteHost, SessionSummary } from "../types";
import { IconButton } from "./IconButton";
import { ProviderSettings } from "./ProviderSettings";
import { StorageSettings } from "./StorageSettings";
import { Toggle } from "./Toggle";

export type Section = "providers" | "general" | "models" | "storage" | "environment" | "agents" | "machines" | "keybinds" | "connections";
export const sections = [
  { id: "general" as const, label: "General", icon: Settings2 },
  { id: "models" as const, label: "Models", icon: Cpu },
  { id: "providers" as const, label: "Providers", icon: ShieldCheck },
  { id: "storage" as const, label: "Storage", icon: HardDrive },
  { id: "environment" as const, label: "Worktree scripts", icon: Wrench },
  { id: "keybinds" as const, label: "Keybinds", icon: Keyboard },
  { id: "machines" as const, label: "Machines", icon: Server },
  { id: "agents" as const, label: "Agents", icon: Bot },
  ...(isMobile ? [{ id: "connections" as const, label: "Hosts", icon: Server }] : []),
];
export const clientSections = new Set<Section>(["models", "keybinds", "connections"]);
const isBuiltInAgent = (agent: AgentProfile) => agent.name === "general";
const firstEditableAgent = (agents: AgentProfile[]) => {
  const editableIndex = agents.findIndex((agent) => !isBuiltInAgent(agent));
  return editableIndex >= 0 ? editableIndex : agents.length ? 0 : -1;
};

function stableSnapshot(value: unknown) {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(value));
}

function settingsSnapshot(settings: AppSettings, agentConfig?: AgentConfig) {
  return stableSnapshot({ settings, agentConfig });
}

function agentEditsSnapshot(config?: AgentConfig) {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(config?.agents.map((item) => item.extensions ? { ...item, extensions: item.extensions.map((path) => path.trim()).filter(Boolean) } : item)));
}

function validAgentMcp(servers: McpServer[]) { return servers.length <= 32 && new Set(servers.map((server) => server.id)).size === servers.length && servers.every((server) => !mcpServerError(server)); }

function mcpServerError(server: McpServer) {
  if (!server.name.trim()) return "Server name is required";
  if (server.startupTimeoutSec !== undefined && (!Number.isInteger(server.startupTimeoutSec) || server.startupTimeoutSec < 1 || server.startupTimeoutSec > 600)) return "Startup timeout must be a whole number between 1 and 600 seconds";
  if ((server.transport ?? "stdio") === "stdio") return server.command.trim() ? undefined : "Command is required";
  return mcpUrlError(server.url) ?? mcpHeadersError(server.headers);
}

function mcpUrlError(value: string | undefined) {
  try {
    const url = new URL(value?.trim() ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return "URL must use HTTP or HTTPS";
  } catch { return "Enter a valid HTTP URL"; }
}

function mcpHeadersError(value: string | undefined) {
  if (value?.trim()) {
    try {
      const headers = JSON.parse(value);
      if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string")) return "Headers must be a JSON object containing string values";
    } catch { return "Headers must be valid JSON"; }
  }
  return undefined;
}

function firstValidationError(checks: Array<() => string | undefined>) {
  for (const check of checks) { const error = check(); if (error) return error; }
}

type SettingsViewProps = { selectedSection?: Section; embedded?: boolean; resourceError?: string; scope?: "client" | "daemon"; daemonLabel?: string; providerHosts?: RemoteHost[]; onSavingChange?: (saving: boolean) => void; providerHostId?: string; settings: AppSettings; pendingSettingsCount?: number; agentConfig?: AgentConfig; sessions?: SessionSummary[]; models?: Model[]; thinkingLevels?: string[]; onSave: (settings: AppSettings, agentConfig?: AgentConfig) => Promise<void>; onDirtyChange?: (dirty: boolean) => void };
function settingsViewDefaults({ selectedSection, embedded = false, resourceError, scope = "daemon", daemonLabel = "Local daemon", providerHosts, onSavingChange, providerHostId = "local", settings, pendingSettingsCount = 0, agentConfig: incomingConfiguration, sessions = [], models = [], thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"], onSave, onDirtyChange }: SettingsViewProps) {
  return { selectedSection, embedded, resourceError, scope, daemonLabel, providerHosts, onSavingChange, providerHostId, settings, pendingSettingsCount, incomingConfiguration, sessions, models, thinkingLevels, onSave, onDirtyChange };
}

export function SettingsView(props: SettingsViewProps) {
  const settingsFields = createMemoFields(() => settingsViewDefaults(props));
  const settingsProps = () => settingsFields;
  const providerHostId = createMemo(() => settingsProps().providerHostId);
  const [saving, setSaving] = createSignal(false);
  createDependencyEffect(() => {
    const capturedSettingsProps = { ...settingsProps() }; const capturedSaving = saving();
 capturedSettingsProps.onSavingChange?.(capturedSaving); return () => capturedSettingsProps.onSavingChange?.(false); }, () => [saving(), settingsProps().onSavingChange]);
  const capabilitiesBeforeSave = createRef({ configuration: settingsProps().incomingConfiguration });
  createComputed(() => { if (!saving()) capabilitiesBeforeSave.current = { configuration: settingsProps().incomingConfiguration }; });
  const agentConfig = createMemo(() => (saving() ? capabilitiesBeforeSave.current.configuration : settingsProps().incomingConfiguration));
  const [draft, setDraft] = createSignal((() => structuredClone(settingsProps().settings))()); const [agentDrafts, setAgentDrafts] = createSignal((() => structuredClone(agentConfig()?.agents ?? []))()); const [agentIndex, setAgentIndex] = createSignal((() => firstEditableAgent(agentConfig()?.agents ?? []))()); const [section, setSection] = createSignal<Section>(settingsProps().scope === "client" ? "keybinds" : "general"); const [saved, setSaved] = createSignal(false); const savingRef = createRef(false); const [saveError, setSaveError] = createSignal<string>();
  const [modelFilter, setModelFilter] = createSignal("");
  const [settingsQuery, setSettingsQuery] = createSignal("");
  const [pastHeader, setPastHeader] = createSignal(false);
  createDependencyEffect(() => {
    const onScroll = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (el && el.classList && el.classList.contains("settings-shell")) setPastHeader(el.scrollTop > 96);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, () => []);
  const [baselineSettings, setBaselineSettings] = createSignal(settingsSnapshot(settingsProps().settings));
  const [baselineAgentConfig, setBaselineAgentConfig] = createSignal(agentEditsSnapshot(agentConfig()));
  const agentConfigSnapshot = createMemo(() => (agentEditsSnapshot(agentConfig())));
  const incomingAgentConfigRef = createRef(agentConfigSnapshot());
  const [hasAgentConfigDraft, setHasAgentConfigDraft] = createSignal(agentConfig() !== undefined);
  const currentAgentConfig = createMemo(() => (hasAgentConfigDraft() ? { agents: agentDrafts().map(item => item.extensions ? { ...item, extensions: item.extensions.map(path => path.trim()).filter(Boolean) } : item), fastModeModels: agentConfig()?.fastModeModels } : undefined));
  const currentSnapshot = createMemo(() => (settingsSnapshot(draft(), currentAgentConfig())));
  const currentSnapshotRef = createRef(currentSnapshot()); createComputed(() => { currentSnapshotRef.current = currentSnapshot(); });
  const agentConfigDirty = createMemo(() => (agentEditsSnapshot(currentAgentConfig()) !== baselineAgentConfig()));
  const dirty = createMemo(() => (settingsSnapshot(draft()) !== baselineSettings() || agentConfigDirty()));
  const [settingsConflict, setSettingsConflict] = createSignal(false);
  const [agentsConflict, setAgentsConflict] = createSignal(false);
  const conflict = () => settingsConflict() || agentsConflict();
  createDependencyEffect(() => {
    if (saving()) return;
    const incoming = settingsProps().settings;
    const baseline = JSON.parse(baselineSettings()).settings as AppSettings;
    if (settingsSnapshot(incoming) === baselineSettings()) return;
    const local = draft();
    const merged = { ...incoming };
    let collisions = false;
    for (const key of Object.keys(local) as Array<keyof AppSettings>) {
      const same = (left: unknown, right: unknown) => stableSnapshot(left) === stableSnapshot(right);
      if (!same(local[key], baseline[key])) {
        if (!same(incoming[key], baseline[key]) && !same(incoming[key], local[key])) collisions = true;
        Object.assign(merged, { [key]: local[key] });
      }
    }
    setDraft(merged);
    setBaselineSettings(settingsSnapshot(incoming));
    if (collisions) setSettingsConflict(true);
  }, () => [settingsProps().settings, saving()]);
  const reloadLatest = () => {
    setDraft(structuredClone(settingsProps().settings));
    setBaselineSettings(settingsSnapshot(settingsProps().settings));
    setAgentDrafts(structuredClone(agentConfig()?.agents ?? []));
    setHasAgentConfigDraft(agentConfig() !== undefined);
    setBaselineAgentConfig(agentEditsSnapshot(agentConfig()));
    incomingAgentConfigRef.current = agentConfigSnapshot();
    setSettingsConflict(false); setAgentsConflict(false);
  };
  createDependencyEffect(() => {
    const capturedSettingsProps = { ...settingsProps() }; const capturedDirty = dirty();
 capturedSettingsProps.onDirtyChange?.(capturedDirty); return () => capturedSettingsProps.onDirtyChange?.(false); }, () => [dirty(), currentSnapshot(), saving(), settingsProps().onDirtyChange]);
  createDependencyEffect(() => {
    const capturedDirty = dirty();
 if (capturedDirty) setSaved(false); }, () => [dirty()]);
  createDependencyEffect(() => { setSaveError(undefined); }, () => [currentSnapshot()]);
  createDependencyEffect(() => { const capturedAgentConfigSnapshot = agentConfigSnapshot(); const capturedAgentConfigDirty = agentConfigDirty(); const capturedAgentConfig = agentConfig();
    if (saving() || incomingAgentConfigRef.current === capturedAgentConfigSnapshot) return;
    if (capturedAgentConfigDirty) {
      if (agentEditsSnapshot(currentAgentConfig()) !== capturedAgentConfigSnapshot) setAgentsConflict(true);
      return;
    }
    incomingAgentConfigRef.current = capturedAgentConfigSnapshot;
    const next = capturedAgentConfig ? structuredClone((capturedAgentConfig)!) : undefined;
    setHasAgentConfigDraft(next !== undefined);
    setAgentDrafts(next?.agents ?? []);
    setAgentIndex(firstEditableAgent(next?.agents ?? []));
    setBaselineAgentConfig(agentEditsSnapshot(next));
  }, () => [agentConfigDirty(), agentConfig(), agentConfigSnapshot(), saving()]);
  const patch = (value: Partial<AppSettings>) => setDraft((current) => ({ ...current, ...value }));
  const save = async () => {
    if (conflict()) return;
    const capturedDirty = dirty(); const capturedSettingsProps = { ...settingsProps() }; const capturedDraft = draft(); const capturedAgentConfigDirty = agentConfigDirty(); const capturedCurrentAgentConfig = currentAgentConfig(); const capturedCurrentSnapshot = currentSnapshot();
 if (savingRef.current || !capturedDirty) return; savingRef.current = true; setSaving(true); setSaveError(undefined); try { await capturedSettingsProps.onSave(capturedDraft, capturedAgentConfigDirty ? capturedCurrentAgentConfig : undefined); setBaselineSettings(settingsSnapshot(capturedDraft)); if (capturedAgentConfigDirty) setBaselineAgentConfig(agentEditsSnapshot(capturedCurrentAgentConfig)); setSaved(currentSnapshotRef.current === capturedCurrentSnapshot); window.setTimeout(() => setSaved(false), 1600); } catch (reason) { setSaveError(reason instanceof Error ? reason.message : String(reason)); } finally { savingRef.current = false; setSaving(false); } };
  const nextAgentSuffixRef = createRef(agentDrafts().length);
  const addMcp = () => { if (agent()) updateAgent({ mcpServers: [...agent().mcpServers, { id: uid("mcp"), name: "New server", transport: "stdio", command: "npx", args: "", enabled: true }] }); };
  const updateMcp = (id: string, value: Partial<McpServer>) => { if (agent()) updateAgent({ mcpServers: agent().mcpServers.map((server) => server.id === id ? { ...server, ...value } : server) }); };
  const removeMcp = (id: string) => { if (agent()) updateAgent({ mcpServers: agent().mcpServers.filter((server) => server.id !== id) }); };
  const addHost = () => setDraft((current) => ({ ...current, hosts: [...current.hosts, { id: uid("host"), name: "New machine", target: "", piPath: "piop-daemon" }] }));
  const updateHost = (id: string, value: Partial<RemoteHost>) => setDraft((current) => ({ ...current, hosts: current.hosts.map((host) => host.id === id ? { ...host, ...value } : host) }));
  const removeHost = (host: RemoteHost) => {
    const count = settingsProps().sessions.filter((session) => session.hostId === host.id).length;
    if (settingsProps().settings.hosts.some((item) => item.id === host.id) && !window.confirm(`Remove ${host.name}? ${count ? `${count} indexed conversation${count === 1 ? "" : "s"} depend${count === 1 ? "s" : ""}` : "Conversations may depend"} on this machine and will become unavailable.`)) return;
    setDraft((current) => ({ ...current, hosts: current.hosts.filter((item) => item.id !== host.id) }));
  };
  const agent = createMemo(() => (agentDrafts()[agentIndex()]));
  const agentFastModeEnabled = createMemo(() => (agent()?.fastMode ?? draft().defaultFastMode));
  const updateAgent = (value: Partial<AgentProfile>) => setAgentDrafts((current) => current.map((item, index) => index === agentIndex() ? { ...item, ...value } : item));
  const toggleAgentResource = (key: "tools" | "skills", value: string) => { if (agent()) updateAgent({ [key]: agent()[key].includes(value) ? agent()[key].filter((item) => item !== value) : [...agent()[key], value] }); };
  const renameAgent = (name: string) => { if (!agent() || (!isBuiltInAgent(agent()) && name.trim().toLowerCase() === "general")) return; if ((draft().defaultAgent ?? "general") === agent().name) patch({ defaultAgent: name }); updateAgent({ name }); };
  const addAgent = () => { if (!agentConfig() || saving()) return; let suffix = nextAgentSuffixRef.current; while (agentDrafts().some((item) => item.name.toLowerCase() === `agent-${suffix}`)) suffix += 1; nextAgentSuffixRef.current = suffix + 1; const next: AgentProfile = { name: `agent-${suffix}`, model: "", effort: "", path_systemprompt: "sysprompt/default.md", path_agentprompt: "", tools: draft().tools.filter((item) => item.enabled).map((item) => item.name), skills: draft().skills.filter((item) => item.enabled).map((item) => item.path), mcpServers: [] }; setAgentDrafts((current) => [...current, next]); setAgentIndex(agentDrafts().length - 1); };
  const removeAgent = () => { if (!agent() || isBuiltInAgent(agent())) return; if (draft().defaultAgent === agent().name) patch({ defaultAgent: "general" }); const next = agentDrafts().filter((_, index) => index !== agentIndex()); setAgentDrafts(next); setAgentIndex(firstEditableAgent(next)); };
  const agentLevels = (item: AgentProfile) => {
    const model = settingsProps().models.find((model) => `${model.provider}/${model.id}` === (item.model || draft().defaultModel));
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (!model) return levels;
    if (!model.reasoning) return ["off"];
    return levels.filter((level) => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
  };
  const supportsFastMode = (model: string) => (agentConfig()?.fastModeModels ?? []).includes(model.replace(/--piop-account-\d+(?=\/)/, ""));
  const validateAgentResources = () => {
    const availableModelIds = new Set(settingsProps().models.map((model) => `${model.provider}/${model.id}`));
    const hiddenModels = new Set(draft().hiddenModels);
    const modelChoices = [...settingsProps().models.map((model) => ({ id: `${model.provider}/${model.id}`, name: accountModelName(model, settingsProps().models) }))];
    for (const id of hiddenModels) if (!availableModelIds.has(id)) modelChoices.push({ id, name: id });
    const filteredModelChoices = modelChoices.filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase().includes(modelFilter().trim().toLocaleLowerCase()));
    const modelDiscoveryUnavailable = settingsProps().models.length === 0;
    const thinkingDiscoveryUnavailable = modelDiscoveryUnavailable;
    const agentsValid = !agentConfig() || (agentDrafts().some(isBuiltInAgent) && agentDrafts().every((item) => item.name.length > 0 && !!item.path_systemprompt?.trim() && (!item.model || modelDiscoveryUnavailable || availableModelIds.has(item.model)) && (!item.effort || thinkingDiscoveryUnavailable || agentLevels(item).includes(item.effort)) && validAgentMcp(item.mcpServers)) && new Set(agentDrafts().map((item) => item.name)).size === agentDrafts().length);
    const defaultAgentAvailable = !agentConfig() || agentDrafts().some((item) => item.name === (draft().defaultAgent ?? "general"));
    const invalidHost = draft().hosts.find((host) => !host.name.trim() || !host.target.trim() || !host.piPath.trim());
    const invalidMcp = agentDrafts().flatMap((item) => item.mcpServers).find((server) => mcpServerError(server));
    return { availableModelIds, hiddenModels, modelChoices, filteredModelChoices, modelDiscoveryUnavailable, thinkingDiscoveryUnavailable, agentsValid, defaultAgentAvailable, invalidHost, invalidMcp };
  };
  const agentValidation = createMemo(() => (validateAgentResources()));
  const validateShortcuts = () => {
    const shortcutList = Object.values(draft().keybindings).filter((shortcut) => shortcut.trim());
    const duplicateShortcuts = new Set<string>();
    for (let i = 0; i < shortcutList.length; i += 1) for (let j = i + 1; j < shortcutList.length; j += 1) {
      const left = shortcutList[i].trim().toLowerCase();
      const right = shortcutList[j].trim().toLowerCase();
      if (left === right || shortcutsConflict(shortcutList[i], shortcutList[j])) {
        duplicateShortcuts.add(left);
        duplicateShortcuts.add(right);
      }
    }
    const error = shortcutList.map(shortcutError).find(Boolean);
    return { shortcutList, duplicateShortcuts, error };
  };
  const shortcutValidation = createMemo(() => (validateShortcuts()));
  const validateSettingsNames = () => {
    const contextWindowValid = Number.isInteger(draft().contextWindowCap) && draft().contextWindowCap >= 1000 && draft().contextWindowCap <= 10000000 && Number.isSafeInteger(draft().contextWindowCap);
    const duplicateNames = <T extends { name: string }>(items: T[]) => { const counts = new Map<string, number>(); items.forEach((item) => { const name = item.name.trim().toLowerCase(); if (name) counts.set(name, (counts.get(name) ?? 0) + 1); }); return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name)); };
    const duplicateHostNames = duplicateNames(draft().hosts);
    const reservedLocalHostName = draft().hosts.some((host) => host.name.trim().toLowerCase() === "local");
    const duplicateMcpNames = duplicateNames(agent()?.mcpServers ?? []);
    const duplicateAgentNames = duplicateNames(agentDrafts());
    const invalidAgentModel = agentValidation().modelDiscoveryUnavailable ? undefined : agentDrafts().find((item) => item.model && !agentValidation().availableModelIds.has(item.model));
    const invalidAgentEffort = agentValidation().thinkingDiscoveryUnavailable ? undefined : agentDrafts().find((item) => item.effort && !agentLevels(item).includes(item.effort));
    const emptyAgent = agentDrafts().find((item) => !item.name.trim());
    const missingAgentPrompt = agentDrafts().find((item) => !item.path_systemprompt?.trim());
    return { contextWindowValid, duplicateNames, duplicateHostNames, reservedLocalHostName, duplicateMcpNames, duplicateAgentNames, invalidAgentModel, invalidAgentEffort, emptyAgent, missingAgentPrompt };
  };
  const nameValidation = createMemo(() => (validateSettingsNames()));
  const validationError = createMemo(() => (firstValidationError([
    () => !agentValidation().defaultAgentAvailable ? `Default agent is unavailable: ${draft().defaultAgent}` : undefined,
    () => !nameValidation().contextWindowValid ? "Context window cap must be a whole number from 1000 to 10000000" : undefined,
    () => draft().hosts.length > 16 ? "At most 16 remote machines can be configured" : undefined,
    () => nameValidation().reservedLocalHostName ? "The machine name “Local” is reserved for this machine" : undefined,
    () => nameValidation().duplicateHostNames.size ? `Machine name “${[...nameValidation().duplicateHostNames][0]}” is used more than once` : undefined,
    () => agentValidation().invalidHost ? `${(agentValidation().invalidHost)!.name.trim() || "Machine"}: name, SSH target, and Pi executable are required` : undefined,
    () => agentDrafts().some((item) => item.mcpServers.length > 32) ? "At most 32 MCP servers can be configured per agent" : undefined,
    () => nameValidation().duplicateMcpNames.size ? `MCP server name “${[...nameValidation().duplicateMcpNames][0]}” is used more than once` : undefined,
    () => agentValidation().invalidMcp ? `${(agentValidation().invalidMcp)!.name.trim() || "MCP server"}: ${mcpServerError((agentValidation().invalidMcp)!)}` : undefined,
    () => shortcutValidation().error,
    () => shortcutValidation().duplicateShortcuts.size ? `Shortcut “${[...shortcutValidation().duplicateShortcuts][0]}” is assigned more than once` : undefined,
    () => !agentDrafts().some(isBuiltInAgent) && agentConfig() ? "The built-in general agent is required" : undefined,
    () => nameValidation().emptyAgent ? "Agent name is required" : undefined,
    () => nameValidation().duplicateAgentNames.size ? `Agent name “${[...nameValidation().duplicateAgentNames][0]}” is used more than once` : undefined,
    () => nameValidation().invalidAgentModel ? `${(nameValidation().invalidAgentModel)!.name}: model is unavailable: ${(nameValidation().invalidAgentModel)!.model}` : undefined,
    () => nameValidation().invalidAgentEffort ? `${(nameValidation().invalidAgentEffort)!.name}: effort is unavailable: ${(nameValidation().invalidAgentEffort)!.effort}` : undefined,
    () => nameValidation().missingAgentPrompt ? `${(nameValidation().missingAgentPrompt)!.name}: system prompt file is required. Set it in Settings → Agents; for an older profile, restart Piop to migrate its prompt.` : undefined,
    () => !agentValidation().agentsValid ? "Every agent needs a unique name and valid resources" : undefined
  ])));
  const validateForm = () => {
    const invalidFastModeAgent = agentDrafts().find((item) => item.fastMode === true && !supportsFastMode(item.model || draft().defaultModel));
    const fastModeValidationError = invalidFastModeAgent ? `${invalidFastModeAgent.name}: model ${invalidFastModeAgent.model || draft().defaultModel} does not support fast mode` : undefined;
    const formValid = agentValidation().agentsValid && !validationError() && !fastModeValidationError;
    const searchTerms = settingsQuery().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matchingSections = sections.filter((item) => clientSections.has(item.id) === (settingsProps().scope === "client") && searchTerms.every((term) => item.label.toLocaleLowerCase().includes(term)));
    const visibleSection = settingsProps().selectedSection ?? (matchingSections.some((item) => item.id === section()) ? section() : matchingSections[0]?.id);

    return { invalidFastModeAgent, fastModeValidationError, formValid, searchTerms, matchingSections, visibleSection };
  };
  const formFields = createMemoFields(validateForm);
  const formValidation = () => formFields;
  const renderSettingsHeader = () => {
    const renderSaveControls = () => {
      const renderUnsavedBadge = () => (dirty() && !saving() && <small role="status" class="unsaved-badge"><span aria-hidden="true" />Unsaved changes</small>);
      const renderPendingSettingsCount = () => (settingsProps().pendingSettingsCount > 0 && !dirty() && <small role="status">Saved · waiting for {settingsProps().pendingSettingsCount} session{settingsProps().pendingSettingsCount === 1 ? "" : "s"} to apply changes</small>);
      const renderSaveButton = () => (conflict() ? <small role="alert">Settings changed in another window. <button disabled={saving()} onClick={reloadLatest}>Reload latest settings and discard local edits</button></small> : (saveError() || validationError() || formValidation().fastModeValidationError) && <small role="alert">{saveError() || validationError() || formValidation().fastModeValidationError}</small>);
      const renderSaveButtonLabel = () => {
        const renderSaveStatus = () => (saved() && !dirty() ? <Check size={15} /> : <Save size={15} />);
        const renderSaveLabel = () => (saved() && !dirty() ? "Saved" : saving() ? "Saving…" : "Save changes");
        return (<button class={dirty() && !saving() && formValidation().formValid ? "primary-button needs-save" : "primary-button"} disabled={saving() || conflict() || !dirty() || !formValidation().formValid} onClick={() => void save()}>{renderSaveStatus()}{renderSaveLabel()}</button>);
      };
      return (<div class="settings-save">{renderUnsavedBadge()}{renderPendingSettingsCount()}{renderSaveButton()}{renderSaveButtonLabel()}</div>);
    };
    return (<header class="settings-header"><div><p class="eyebrow">piop</p><h1>{settingsProps().scope === "client" ? "Client settings" : settingsProps().daemonLabel + " settings"}</h1><p>Client preferences stay on this device. Daemon settings belong to the machine running piop.</p></div>{renderSaveControls()}</header>);
  };
  const renderSettingsLayout = () => {
    const renderSettingsContent = () => {
      const renderWorktreeScripts = () => (formValidation().visibleSection === "environment" && <SettingsSection title="Worktree scripts" description="Assign setup and cleanup scripts to a project and machine. Setup runs in order after creation; cleanup runs in reverse order before deletion. A failure stops the operation and keeps the worktree." headerAction={<button class="secondary-button" onClick={() => patch({ worktreeSetupScripts: [...(draft().worktreeSetupScripts ?? []), { id: uid("setup"), name: "Worktree script", script: "", cleanupScript: "", enabled: true, projectPath: "", hostId: "local" }] })}><CirclePlus size={15} />Add script</button>}>
        <p>Source workspace: <code>PIOP_SOURCE_TREE_PATH</code><br />Worktree: <code>PIOP_WORKTREE_PATH</code><br />Branch: <code>PIOP_WORKTREE_BRANCH</code></p>
        {<Key each={(draft().worktreeSetupScripts ?? [])} by={(script) => script.id}>{(script, index) => {
          const update = (value: Partial<ReturnType<typeof script>>) => patch({ worktreeSetupScripts: (draft().worktreeSetupScripts ?? []).map((item) => item.id === script().id ? { ...item, ...value } : item) });
          return <div class="setup-script" >
            <p>Runs on {settingsProps().daemonLabel}.{script().hostId && script().hostId !== "local" && <> This older script targets another machine. <button onClick={() => update({ hostId: "local", projectPath: "" })}>Assign to this daemon</button></>}</p>
            <div class="section-actions"><strong>Script {index() + 1}</strong><Toggle label={`Enable ${script().name}`} checked={script().enabled} onChange={(enabled) => update({ enabled })} /><button disabled={index() === 0} onClick={() => { const reordered = [...(draft().worktreeSetupScripts ?? [])];[reordered[index() - 1], reordered[index()]] = [reordered[index()], reordered[index() - 1]]; patch({ worktreeSetupScripts: reordered }); }}>Move up</button><button onClick={() => patch({ worktreeSetupScripts: (draft().worktreeSetupScripts ?? []).filter((item) => item.id !== script().id) })}>Remove</button></div>
            <label class="field"><span>Name</span><input aria-label={`Script ${index() + 1} name`} value={script().name} onInput={(event) => update({ name: event.target.value })} /></label>
            <label class="field"><span>Project directory</span><input aria-label={`Script ${index() + 1} project directory`} list={`setup-projects-${script().id}`} placeholder="Absolute path to the repository" value={script().projectPath ?? ""} onInput={(event) => update({ projectPath: event.target.value })} /></label>
            <datalist id={`setup-projects-${script().id}`}>{<Key each={[...new Set(settingsProps().sessions.filter((session) => (session.hostId ?? "local") === (script().hostId ?? "local") && session.projectKind !== "no-repo").map((session) => session.projectRoot ?? session.cwd))]} by={(path) => path}>{(path, _index) => <option  value={path()} />}</Key>}</datalist>
            {!script().projectPath?.trim() && <p class="empty-small">Choose a project directory to run this script. Unassigned scripts are kept but do not run.</p>}
            <label class="field"><span>Setup Bash script</span><textarea class="setup-script-code" aria-label={`Script ${index() + 1} setup Bash code`} rows={8} spellcheck={false} placeholder={'npm ci\n# Or copy files from "$PIOP_SOURCE_TREE_PATH"'} value={script().script} onInput={(event) => update({ script: event.target.value })} /></label>
            <label class="field"><span>Cleanup Bash script</span><textarea class="setup-script-code" aria-label={`Script ${index() + 1} cleanup Bash code`} rows={8} spellcheck={false} placeholder={'# Remove resources created for "$PIOP_WORKTREE_BRANCH"'} value={script().cleanupScript ?? ""} onInput={(event) => update({ cleanupScript: event.target.value })} /></label>
          </div>;
        }}</Key>}
        {!draft().worktreeSetupScripts?.length && <div class="empty-small">Add scripts to prepare new worktrees and clean up their external resources before deletion.</div>}
      </SettingsSection>);
      const renderGeneral = () => (formValidation().visibleSection === "general" && <SettingsSection title="General" description="Agent behavior.">
        <SettingRow icon={<CircleGauge />} title="Default context window cap" description="Applies to new conversations. Each conversation keeps its initial cap, including whether it is enabled."><div class="setting-cap-controls"><input class="setting-number" aria-label="Context window cap" aria-invalid={!nameValidation().contextWindowValid} disabled={!draft().contextWindowCapEnabled} type="number" min={1000} max={10000000} step={1000} value={draft().contextWindowCap} onInput={(event) => patch({ contextWindowCap: Number(event.target.value) })} /><Toggle label="Enable context window cap" checked={draft().contextWindowCapEnabled} onChange={(contextWindowCapEnabled) => patch({ contextWindowCapEnabled })} /></div></SettingRow>
        <SettingRow icon={<ShieldCheck />} title="Automatic retry" description="Retry transient provider and network errors."><Toggle label="Automatic retry" checked={draft().autoRetry} onChange={(autoRetry) => patch({ autoRetry })} /></SettingRow>
        <div class="general-agent-default">
          <label class="field"><span>Default agent</span><select aria-label="Default agent" disabled={!agentConfig()} value={draft().defaultAgent ?? "general"} onChange={(event) => patch({ defaultAgent: event.target.value })}>{!agentValidation().defaultAgentAvailable && <option value={draft().defaultAgent} disabled>Unavailable: {draft().defaultAgent}</option>}{!agentConfig() && <option value={draft().defaultAgent ?? "general"}>{draft().defaultAgent ?? "general"}</option>}{<Key each={agentDrafts().filter((agent) => agent.name !== "voice-orchestrator")} by={(item) => item.name}>{(item, _index) => <option  value={item().name}>{item().name}</option>}</Key>}</select></label>
        </div>
      </SettingsSection>);
      const renderModels = () => (formValidation().visibleSection === "models" && <SettingsSection title="Models" description="Choose which models appear in chat pickers. Existing conversations and default models are unchanged. Newly arrived models start hidden." headerAction={<label class="section-filter"><Search size={14} /><input aria-label="Filter models" placeholder="Filter by name or provider" value={modelFilter()} onInput={(event) => setModelFilter(event.target.value)} /></label>}>
        <div class="config-list">{<Key each={agentValidation().filteredModelChoices} by={(model) => model.id}>{(model, _index) => <div class="config-row model-row" ><span class="config-icon"><Cpu size={16} /></span><span><strong>{model().name}</strong><small>{model().id}{!agentValidation().availableModelIds.has(model().id) ? " · Currently unavailable" : ""}</small></span><Toggle label={`Show ${model().id}`} checked={!agentValidation().hiddenModels.has(model().id)} onChange={(visible) => setDraft((current) => ({ ...current, hiddenModels: visible ? current.hiddenModels.filter((id) => id !== model().id) : [...current.hiddenModels, model().id] }))} /></div>}</Key>}</div>
        {!agentValidation().filteredModelChoices.length && <div class="empty-small">{agentValidation().modelChoices.length ? "No models match your search." : "No models discovered. Connect to a session to manage model visibility."}</div>}
      </SettingsSection>);
      const renderAgents = () => {
        const renderAgentEditor = () => {
          const renderAgentFields = () => {
            const renderAgentNameRow = () => (<div class="agent-name-row"><label class="field"><span>Agent name</span><input aria-label="Agent name" aria-invalid={!isBuiltInAgent(agent()) && (!agent().name.trim() || agent().name.trim().toLowerCase() === "general" || nameValidation().duplicateAgentNames.has(agent().name.trim().toLowerCase()))} disabled={isBuiltInAgent(agent())} value={agent().name} onInput={(event) => { renameAgent(event.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, "")); event.currentTarget.value = agent().name; }} /></label><IconButton label={`Remove ${agent().name}`} disabled={isBuiltInAgent(agent())} onClick={removeAgent}><Trash2 size={15} /></IconButton></div>);
            const renderAgentDefaults = () => {
              const renderAgentModel = () => (<label class="field"><span>Default model</span><select aria-label="Agent default model" value={agent().model} onChange={(event) => updateAgent({ model: event.target.value })}><option value="">Use fallback ({draft().defaultModel})</option>{agent().model && !agentValidation().availableModelIds.has(agent().model) && <option value={agent().model} disabled>Unavailable: {agent().model}</option>}{<Key each={settingsProps().models} by={(model) => `${model.provider}/${model.id}`}>{(model, _index) => <option  value={`${model().provider}/${model().id}`}>{accountModelName(model(), settingsProps().models)}</option>}</Key>}</select></label>);
              const renderAgentFastMode = () => (<div class="field general-fast-mode" title={agent().fastMode === undefined ? "Using the fallback fast mode setting" : "Fast mode default for this agent"}><span>Fast mode</span><div><button type="button" class={`fast-mode-indicator${agentFastModeEnabled() ? " active" : ""}`} aria-label="Agent fast mode" aria-description={agent().fastMode === undefined ? "Using fallback setting" : agentFastModeEnabled() ? "Fast mode on" : "Fast mode off"} aria-pressed={agentFastModeEnabled()} aria-invalid={agent().fastMode === true && !supportsFastMode(agent().model || draft().defaultModel)} onClick={() => updateAgent({ fastMode: !agentFastModeEnabled() })}><Zap size={22} strokeWidth={1.5} fill={agentFastModeEnabled() ? "currentColor" : "none"} aria-hidden="true" /></button></div></div>);
              const renderAgentEffort = () => (<label class="field"><span>Default effort</span><select aria-label="Agent default effort" aria-invalid={Boolean(!agentValidation().thinkingDiscoveryUnavailable && agent().effort && !agentLevels(agent()).includes(agent().effort))} value={agent().effort} onChange={(event) => updateAgent({ effort: event.target.value })}><option value="">Use fallback ({draft().defaultThinking})</option>{agent().effort && !agentLevels(agent()).includes(agent().effort) && <option value={agent().effort} disabled>Unavailable: {agent().effort}</option>}{<Key each={agentLevels(agent())} by={(level) => level}>{(level, _index) => <option  value={level()}>{level().charAt(0).toUpperCase() + level().slice(1)}</option>}</Key>}</select></label>);
              return (<div class="agent-defaults">{renderAgentModel()}{renderAgentFastMode()}{renderAgentEffort()}</div>);
            };
            const renderAgentPromptFiles = () => (<label class="field"><span>System prompt file</span><input aria-label="System prompt file" aria-invalid={!agent().path_systemprompt?.trim()} placeholder="Path relative to agent config.json, or absolute path" value={agent().path_systemprompt ?? ""} onInput={(event) => updateAgent({ path_systemprompt: event.target.value })} /></label>);
            return (<Show when={agent()}><div class="agent-fields">{renderAgentNameRow()}
              {renderAgentDefaults()}
              {renderAgentPromptFiles()}<label class="field"><span>Agent prompt file</span><input aria-label="Agent prompt file" placeholder="Optional path to an agent prompt file" value={agent().path_agentprompt ?? ""} onInput={(event) => updateAgent({ path_agentprompt: event.target.value })} /></label>
              <label class="field"><span>piop extensions (one path per line)</span><textarea aria-label="Agent piop extensions" placeholder="/path/to/extension.ts" value={(agent().extensions ?? []).join("\n")} onInput={(event) => updateAgent({ extensions: event.target.value.split("\n") })} onBlur={() => updateAgent({ extensions: (agent().extensions ?? []).map(path => path.trim()).filter(Boolean) })} /></label>
              <AgentAllowlist title="Tools">{<Key each={draft().tools} by={(tool) => tool.name}>{(tool, _index) => <label ><input type="checkbox" aria-label={`Allow ${tool().name}`} checked={agent().tools.includes(tool().name)} onInput={() => toggleAgentResource("tools", tool().name)} />{tool().name}</label>}</Key>}</AgentAllowlist><AgentAllowlist title="Skills">{<Key each={draft().skills} by={(skill) => skill.path}>{(skill, _index) => <label ><input type="checkbox" aria-label={`Allow ${skill().name}`} checked={agent().skills.includes(skill().path)} onInput={() => toggleAgentResource("skills", skill().path)} />{skill().name}</label>}</Key>}</AgentAllowlist><div class="agent-mcp-settings"><h3>MCP servers</h3><div class="mcp-list">{<Key each={agent().mcpServers} by={(server) => server.id}>{(server, _index) => { const fieldError = createMemo(() => (mcpServerError(server()))); return <div class="mcp-card" ><div class="mcp-card-head"><span class="config-icon mcp"><PlugZap size={16} /></span><input aria-label="Server name" aria-invalid={!server().name.trim() || nameValidation().duplicateMcpNames.has(server().name.trim().toLowerCase())} value={server().name} onInput={(e) => updateMcp(server().id, { name: e.target.value })} /><Toggle label={`Enable ${server().name}`} checked={server().enabled} onChange={(enabled) => updateMcp(server().id, { enabled })} /><IconButton label={`Remove ${server().name}`} onClick={() => removeMcp(server().id)}><Trash2 size={15} /></IconButton></div>{fieldError() && <small class="mcp-error" role="alert">{fieldError()}</small>}<div class="field"><span>Transport</span><div class="mcp-transport-toggle" role="group" aria-label={`${server().name} transport`}>{<Key each={(["stdio", "http"] as const)} by={(transport) => transport}>{(transport, _index) => <button  type="button" aria-pressed={(server().transport ?? "stdio") === transport()} onClick={() => updateMcp(server().id, { transport: transport() })}>{transport() === "stdio" ? "stdio" : "HTTP"}</button>}</Key>}</div></div><label class="field"><span>Startup timeout (seconds)</span><input type="number" min={1} max={600} step={1} aria-label={`${server().name} startup timeout`} value={server().startupTimeoutSec ?? 10} onInput={(event) => { const value = event.target.value; updateMcp(server().id, { startupTimeoutSec: Number(value) }); }} /></label><Toggle label={`Supply Piop agent ID to ${server().name}`} checked={server().injectAgentId === true} onChange={(injectAgentId) => updateMcp(server().id, { injectAgentId })} />{(server().transport ?? "stdio") === "stdio" ? <div class="command-fields stdio-fields"><label><span>Command</span><input aria-invalid={!server().command.trim()} value={server().command} onInput={(e) => updateMcp(server().id, { command: e.target.value })} /></label><label><span>Arguments</span><input value={server().args} onInput={(e) => updateMcp(server().id, { args: e.target.value })} /></label></div> : <div class="command-fields http-fields"><label><span>URL</span><input type="url" aria-invalid={Boolean(fieldError()?.includes("URL"))} placeholder="https://example.com/mcp" value={server().url ?? ""} onInput={(e) => updateMcp(server().id, { url: e.target.value })} /></label><label><span>Headers (JSON)</span><input aria-invalid={Boolean(fieldError()?.startsWith("Headers"))} placeholder={'{"Authorization":"Bearer …"}'} value={server().headers ?? ""} onInput={(e) => updateMcp(server().id, { headers: e.target.value })} /></label></div>}</div>; }}</Key>}</div><button class="secondary-button" disabled={agent().mcpServers.length >= 32} onClick={addMcp}><CirclePlus size={15} />Add MCP server</button></div>
            </div></Show>);
          };
          return (<>{!agentConfig() && <p role={settingsProps().resourceError ? "alert" : "status"}>{settingsProps().resourceError ? "Could not load agent definitions: " + (settingsProps().resourceError)! : "Loading agent definitions…"}</p>}
          <div class="agent-editor"><div class="agent-list">{<Index each={agentDrafts()}>{(item, index) => <button  class={index === agentIndex() ? "active" : ""} onClick={() => setAgentIndex(index)}><Bot size={14} /><span>{item().name}</span>{isBuiltInAgent(item()) && <small>Built in</small>}</button>}</Index>}</div>
            {renderAgentFields()}
          </div></>);
        };
        return (formValidation().visibleSection === "agents" && <SettingsSection title="Agents" description="Choose defaults, instructions, and the resources each agent may see." headerAction={<button class="secondary-button" disabled={!agentConfig() || saving()} onClick={addAgent}><CirclePlus size={15} />Add agent</button>}>
          {renderAgentEditor()}
        </SettingsSection>);
      };
      return (<section class="settings-content">
        {!formValidation().matchingSections.length && <div class="empty-small" role="status">No settings match your search.</div>}
        {formValidation().visibleSection === "providers" && <Rerun on={providerHostId}>{(_key) => <ProviderSettings  hosts={settingsProps().providerHosts ?? settingsProps().settings.hosts} initialHostId={settingsProps().providerHostId} fixedHost />}</Rerun>}
        {renderWorktreeScripts()}
        {renderGeneral()}
        {renderModels()}
        {formValidation().visibleSection === "connections" && <SettingsSection title="Hosts" description="Saved daemon connections are stored on this device."><button class="secondary-button" disabled={dirty() || saving()} onClick={() => window.dispatchEvent(new Event("piop-mobile-disconnect"))}>Manage saved hosts</button>{dirty() && <p>Save your changes before switching hosts.</p>}</SettingsSection>}
        {renderAgents()}
        {formValidation().visibleSection === "storage" && <StorageSettings hostId={settingsProps().providerHostId} />}
        {formValidation().visibleSection === "machines" && <SettingsSection title="Machines" description="Connect to Piop daemons over SSH. Sessions and configuration stay on each machine."><div class="mcp-list"><div class="mcp-card"><div class="mcp-card-head"><span class="config-icon mcp"><Server size={16} /></span><strong>Local</strong><code>This machine</code></div></div>{<Key each={draft().hosts} by={(host) => host.id}>{(host, _index) => <div class="mcp-card" ><div class="mcp-card-head"><span class="config-icon mcp"><Server size={16} /></span><input aria-label="Machine name" aria-invalid={!host().name.trim() || host().name.trim().toLowerCase() === "local" || nameValidation().duplicateHostNames.has(host().name.trim().toLowerCase())} value={host().name} onInput={(event) => updateHost(host().id, { name: event.target.value })} /><IconButton label={`Remove ${host().name}`} onClick={() => removeHost(host())}><Trash2 size={15} /></IconButton></div><div class="command-fields"><label><span>SSH target</span><input aria-label={`${host().name} SSH target`} aria-invalid={!host().target.trim()} placeholder="user@example.com" value={host().target} onInput={(event) => updateHost(host().id, { target: event.target.value })} /></label><label><span>Piop daemon executable</span><input aria-label={`${host().name} Piop daemon executable`} aria-invalid={!host().piPath.trim()} placeholder="piop-daemon" value={host().piPath === "pi" ? "piop-daemon" : host().piPath.endsWith("/pi") ? `${host().piPath.slice(0, -2)}piop-daemon` : host().piPath} onInput={(event) => updateHost(host().id, { piPath: event.target.value })} /></label></div></div>}</Key>}</div><button class="secondary-button" disabled={draft().hosts.length >= 16} onClick={addHost}><CirclePlus size={15} />Add machine</button></SettingsSection>}
        {formValidation().visibleSection === "keybinds" && <SettingsSection title="Keybinds" description="Customize global application shortcuts."><div class="keybind-list">{<Key each={keybindDefinitions} by={(binding) => binding.action}>{(binding, _index) => <label class="keybind-row" ><span><strong>{binding().label}</strong><small>{binding().description}</small></span><KeybindInput action={binding().action} value={draft().keybindings[binding().action]} invalid={shortcutValidation().duplicateShortcuts.has(draft().keybindings[binding().action].trim().toLowerCase())} onChange={(shortcut) => setDraft((current) => ({ ...current, keybindings: { ...current.keybindings, [binding().action]: shortcut } }))} /></label>}</Key>}</div><button class="secondary-button" onClick={() => patch({ keybindings: { ...defaultKeybindings } })}><RotateCcw size={15} />Restore defaults</button></SettingsSection>}

      </section>);
    };
    return (<div class={settingsProps().embedded ? "settings-layout settings-layout-embedded" : "settings-layout"}>{!settingsProps().embedded && <nav class="settings-nav"><label class="search settings-search"><Search size={15} /><input autofocus type="search" aria-label="Search settings" placeholder="Search settings" value={settingsQuery()} onInput={(event) => setSettingsQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSettingsQuery(""); } }} /></label>{<Key each={formValidation().matchingSections} by={(item) => item.id}>{(item, _index) => <button  class={formValidation().visibleSection === item().id ? "active" : ""} aria-current={formValidation().visibleSection === item().id ? "page" : undefined} onClick={() => setSection(item().id)}><Dynamic component={item().icon} size={16} /><span>{item().label}</span></button>}</Key>}</nav>}
      {renderSettingsContent()}</div>);
  };
  const renderSettingsSaveFab = () => (dirty() && pastHeader() && <div class="settings-save-fab"><button class={dirty() && !saving() && formValidation().formValid ? "primary-button needs-save" : "primary-button"} disabled={saving() || conflict() || !dirty() || !formValidation().formValid} onClick={() => void save()}><Save size={15} />{saving() ? "Saving…" : "Save changes"}</button></div>);
  return <main class={dirty() ? "settings-shell has-unsaved" : "settings-shell"}>{renderSettingsHeader()}
    {renderSettingsLayout()}
    {renderSettingsSaveFab()}
  </main>;
}

function SettingsSection(componentProps: { title: string; description: string; headerAction?: JSXElement; children: JSXElement }) { return <div class="settings-section"><div class="section-title"><div><h2>{componentProps.title}</h2><p>{componentProps.description}</p></div>{componentProps.headerAction}</div>{componentProps.children}</div>; }
function AgentAllowlist(componentProps: { title: string; children: JSXElement }) { return <fieldset class="agent-allowlist"><legend>{componentProps.title}</legend><div>{componentProps.children}</div></fieldset>; }
function SettingRow(componentProps: { icon: JSXElement; title: string; description: string; children: JSXElement }) { return <div class="setting-row"><span class="setting-icon">{componentProps.icon}</span><span><strong>{componentProps.title}</strong><small>{componentProps.description}</small></span><div>{componentProps.children}</div></div>; }
function KeybindInput(componentProps: { action: KeybindAction; value: string; invalid?: boolean; onChange: (shortcut: string) => void }) { return <input class="keybind-input" aria-label={`${keybindDefinitions.find((item) => item.action === componentProps.action)?.label} shortcut`} aria-invalid={componentProps.invalid} value={componentProps.value} placeholder="Unassigned" readOnly onKeyDown={(event) => { if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) return; event.preventDefault(); event.stopPropagation(); if (event.key === "Backspace" || event.key === "Delete") { componentProps.onChange(""); return; } const shortcut = shortcutFromEvent(event); if (shortcut) componentProps.onChange(shortcut); }} />; }
