import { debugView } from "../lib/debugFeatures";
import { mergeModelIds } from "../lib/modelVisibility";
import { RefreshSkills, RefreshTools } from "./RefreshResources";
import { stableSnapshot, settingsSnapshot, agentEditsSnapshot, settingKeys } from "../lib/settingsSnapshots";
import { applyClientPreferences, clientPreferenceKeys, clientPreferences, ClientPreferenceConflictError, mergeClientPreferences, SettingsSaveError } from "../lib/clientPreferenceMerge";
import { required } from "../lib/required";
import { hostFastModels, rejectsFastMode } from "../lib/fastModels";
import { AgentSkills, AgentTools } from "./AgentTools";
import { AgentExtensions } from "./AgentExtensions";
import { agentProfileSchema } from "../lib/agentSchemas";
import { McpSettings, type McpEditorDraft } from "./McpSettings";
import { CapInput } from "./CapInput";
import { capRangeError } from "../../../extensions/piop-context-window-cap/interface";
import { Key, Rerun } from "@solid-primitives/keyed";
import { createComputed, createEffect, createMemo, createSignal, For, Index, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createDependencyEffect, createMemoFields, createRef, type JSXElement } from "../lib/solid";

import { Bot, Check, CircleGauge, CirclePlus, Clipboard, Cpu, HardDrive, Keyboard, Pencil, PlugZap, RotateCcw, Save, Search, Server, Settings2, ShieldCheck, Trash2, X, Zap } from "lucide-solid";
import { uid } from "../lib/content";
import { defaultKeybindings, keybindDefinitions, shortcutError, shortcutFromEvent, shortcutsConflict, type KeybindAction } from "../lib/keybindings";
import { isMobile } from "../lib/platform";
import type { AgentAccess, AgentConfig, AgentProfile, AppSettings, Model, RemoteHost, SessionSummary } from "../types";
import { IconButton } from "./IconButton";
import { ProviderSettings } from "./ProviderSettings";
import { pluginSettingsEnabled, pluginSettingsSections } from "../plugins/settings";
import { refreshPlugins, setPluginError } from "../plugins";
import { StorageSettings } from "./StorageSettings";
import { PluginSettings } from "./PluginSettings";
import { ToastHistory } from "./ToastHistory";
import { Toggle } from "./Toggle";
import { RemoveHostDialog } from "./RemoveHostDialog";

type CoreSection = "inference" | "general" | "storage" | "agents" | "hosts" | "keybinds" | "connections" | "plugins" | "toasts";

export type Section = CoreSection | (string & Record<never, never>);

/** A settings tab. A tab with a parent shows below the parent tab, as its sub-tab. */
type SettingsSection = { id: Section; label: string; icon: typeof Settings2; plugin?: boolean; parent?: Section };

const mobileSections: SettingsSection[] = isMobile ? [{ id: "connections", label: "Anchor host", icon: Server }] : [];

export const sections: SettingsSection[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "agents", label: "Agents", icon: Bot },
  ...pluginSettingsSections.filter(item => item.within === "agents").map(item => ({ id: item.section, label: item.label, icon: item.icon, plugin: true, parent: "agents" as Section })),
  { id: "inference", label: "Inference", icon: Cpu },
  ...pluginSettingsSections.filter(item => !item.within).map(item => ({ id: item.section, label: item.label, icon: item.icon, plugin: true })),
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "keybinds", label: "Keybinds", icon: Keyboard },
  { id: "toasts", label: "Toast history", icon: Clipboard },
  { id: "plugins", label: "Plugins", icon: PlugZap },
  { id: "hosts", label: "Hosts", icon: Server },
  ...mobileSections,
];

export const clientSections = new Set<Section>(["keybinds", "connections", "toasts"]);

export const visibleClientSections = (toastHistory: boolean) => sections.filter(item => clientSections.has(item.id) && (item.id !== "toasts" || toastHistory) && (!item.plugin || pluginSettingsEnabled("local", item.id)));

export const daemonSections = (hostId: string) => sections.filter((item) => !clientSections.has(item.id) && (item.id !== "hosts" || (hostId === "local" && !isMobile)) && (!item.plugin || pluginSettingsEnabled(hostId, item.id)));

const isBuiltInAgent = (agent: AgentProfile) => agent.name === "general";

type CodemodeChoice = NonNullable<AgentProfile["codemode"]>;
const NEXT_CODEMODE: Record<CodemodeChoice, CodemodeChoice> = { on: "off", off: "on" };
const CODEMODE_HINTS: Record<CodemodeChoice, string> = {
  on: "ON: the agent calls tools directly or from codemode scripts.",
  off: "OFF: the agent calls every tool directly, without codemode.",
};

const firstAgentIndex = (agents: AgentProfile[]) => agents.length ? 0 : -1;

function firstValidationError(checks: Array<() => string | undefined>) {
  for (const check of checks) { const error = check();

  if (error) return error; }
}

function mergeSettingsDraft(incoming: AppSettings, baseline: AppSettings, local: AppSettings) {
  const preferenceMerge = mergeClientPreferences(clientPreferences(incoming), clientPreferences(baseline), clientPreferences(local));
  const merged = applyClientPreferences(incoming, preferenceMerge.preferences);
  let collisions = preferenceMerge.conflicts.length > 0;

  for (const key of settingKeys) {
    if (clientPreferenceKeys.has(key) || !Object.hasOwn(local, key)) continue;

    if (key === "hiddenModels" || key === "knownModels") {
      Object.assign(merged, { [key]: mergeModelIds(incoming[key], baseline[key], local[key]) });
      continue;
    }

    const same = (left: AppSettings[keyof AppSettings], right: AppSettings[keyof AppSettings]) => stableSnapshot(left) === stableSnapshot(right);

    if (!same(local[key], baseline[key])) {
      if (!same(incoming[key], baseline[key]) && !same(incoming[key], local[key])) collisions = true;
      Object.assign(merged, { [key]: local[key] });
    }
  }

  return { merged, collisions };
}

type SettingsViewProps = { selectedSection?: Section; embedded?: boolean; resourceError?: string; scope?: "client" | "daemon"; daemonLabel?: string; providerHosts?: RemoteHost[]; onSavingChange?: (saving: boolean) => void; providerHostId?: string; settings: AppSettings; pendingSettingsCount?: number; agentConfig?: AgentConfig; sessions?: SessionSummary[]; models?: Model[]; loadingModels?: string[]; thinkingLevels?: string[]; onSave: (settings: AppSettings, agentConfig?: AgentConfig, baseline?: AppSettings) => Promise<void>; onDirtyChange?: (dirty: boolean) => void };

function settingsViewDefaults({ selectedSection, embedded = false, resourceError, scope = "daemon", daemonLabel = "Daemon", providerHosts, onSavingChange, providerHostId = "local", settings, pendingSettingsCount = 0, agentConfig: incomingConfiguration, sessions = [], models = [], loadingModels = [], thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"], onSave, onDirtyChange }: SettingsViewProps) {
  return { selectedSection, embedded, resourceError, scope, daemonLabel, providerHosts, onSavingChange, providerHostId, settings, pendingSettingsCount, incomingConfiguration, sessions, models, loadingModels, thinkingLevels, onSave, onDirtyChange };
}

export function SettingsView(props: SettingsViewProps) {
  const settingsFields = createMemoFields(() => settingsViewDefaults(props));
  const settingsProps = () => settingsFields;
  const providerHostId = createMemo(() => settingsProps().providerHostId);
  const [saving, setSaving] = createSignal(false);
  const [saveRevision, setSaveRevision] = createSignal(0);
  const [toolQuery, setToolQuery] = createSignal("");
  const [skillQuery, setSkillQuery] = createSignal("");
  const [mcpDrafts, setMcpDrafts] = createSignal<Array<McpEditorDraft | undefined>>([]);
  const mcpError = createMemo(() => mcpDrafts().find(item => item?.error)?.error);
  createDependencyEffect(() => {
    const capturedSettingsProps = { ...settingsProps() }; const capturedSaving = saving();
 capturedSettingsProps.onSavingChange?.(capturedSaving);

 return () => capturedSettingsProps.onSavingChange?.(false); }, () => [saving(), settingsProps().onSavingChange]);
  const capabilitiesBeforeSave = createRef({ configuration: settingsProps().incomingConfiguration });
  createComputed(() => { if (!saving()) capabilitiesBeforeSave.current = { configuration: settingsProps().incomingConfiguration }; });
  const agentConfig = createMemo(() => (saving() ? capabilitiesBeforeSave.current.configuration : settingsProps().incomingConfiguration));
  const [draft, setDraft] = createSignal((() => structuredClone(settingsProps().settings))()); const [agentDrafts, setAgentDrafts] = createSignal((() => structuredClone(agentConfig()?.agents ?? []))()); const [agentIndex, setAgentIndex] = createSignal((() => firstAgentIndex(agentConfig()?.agents ?? []))()); const [section, setSection] = createSignal<Section>(settingsProps().scope === "client" ? "keybinds" : "general"); const [saved, setSaved] = createSignal(false); const savingRef = createRef(false); const [saveError, setSaveError] = createSignal<string>();
  const retainedSaveError = createRef(false);
  createEffect(() => { const host = settingsProps().providerHostId ?? "local";

  void refreshPlugins(settingsProps().scope === "client" ? "local" : host).catch(reason => setPluginError(host, reason instanceof Error ? reason.message : String(reason))); });
  const [modelFilter, setModelFilter] = createSignal("");
  const [inferenceView, setInferenceView] = createSignal<"models" | "providers">("models");
  const [settingsQuery, setSettingsQuery] = createSignal("");
  const [pastHeader, setPastHeader] = createSignal(false);
  createDependencyEffect(() => {
    const onScroll = (event: Event) => {
      const el = event.target;

      if (el instanceof HTMLElement && el.classList.contains("settings-shell")) setPastHeader(el.scrollTop > 96);
    };

    window.addEventListener("scroll", onScroll, true);

    return () => window.removeEventListener("scroll", onScroll, true);
  }, () => []);
  const [baselineValue, setBaselineValue] = createSignal(structuredClone(settingsProps().settings));
  const baselineSettings = createMemo(() => settingsSnapshot(baselineValue()));
  const [baselineAgentConfig, setBaselineAgentConfig] = createSignal(agentEditsSnapshot(agentConfig()));
  const [baselineAgentRevision, setBaselineAgentRevision] = createSignal(agentConfig()?.revision);
  const agentConfigSnapshot = createMemo(() => (agentEditsSnapshot(agentConfig())));
  const incomingAgentConfigRef = createRef(JSON.stringify([agentConfigSnapshot(), agentConfig()?.revision]));
  const [hasAgentConfigDraft, setHasAgentConfigDraft] = createSignal(agentConfig() !== undefined);
  const currentAgentConfig = createMemo(() => (hasAgentConfigDraft() ? { revision: baselineAgentRevision(), agents: agentDrafts().map(item => item.extensions ? { ...item, extensions: item.extensions.map(path => path.trim()).filter(Boolean) } : item) } : undefined));
  const currentSnapshot = createMemo(() => (settingsSnapshot(draft(), currentAgentConfig())));
  const currentSnapshotRef = createRef(currentSnapshot()); createComputed(() => { currentSnapshotRef.current = currentSnapshot(); });
  const agentConfigDirty = createMemo(() => (Boolean(mcpError()) || agentEditsSnapshot(currentAgentConfig()) !== baselineAgentConfig()));

  const durabilityError = () => {
    const error = settingsProps().scope === "client" ? settingsProps().settings.clientSettingsDurabilityError : settingsProps().settings.settingsDurabilityError;

    return error ? `Changes were published, but disk durability is unconfirmed: ${error}. Retry saving to confirm them.` : undefined;
  };

  const dirty = createMemo(() => (Boolean(durabilityError()) || settingsSnapshot(draft()) !== baselineSettings() || agentConfigDirty()));

  const saveLabel = () => saved() && !dirty() ? "Saved" : saving() ? "Saving…" : durabilityError() ? "Retry save" : "Save changes";

  const [settingsConflict, setSettingsConflict] = createSignal(false);
  const [agentsConflict, setAgentsConflict] = createSignal(false);
  const conflict = () => settingsConflict() || agentsConflict();
  const incomingSettingsSnapshot = createRef("");
  createDependencyEffect(() => {
    if (saving()) return;
    const incoming = settingsProps().settings;
    const incomingSnapshot = JSON.stringify([settingsSnapshot(incoming), incoming.settingsRevision, incoming.clientSettingsRevision, incoming.settingsDurabilityError, incoming.clientSettingsDurabilityError]);

    if (incomingSnapshot === incomingSettingsSnapshot.current) return;
    incomingSettingsSnapshot.current = incomingSnapshot;
    const baseline = baselineValue();

    const { merged, collisions } = mergeSettingsDraft(incoming, baseline, draft());

    setDraft(merged);
    setBaselineValue(structuredClone(incoming));

    if (collisions) setSettingsConflict(true);
  }, () => [settingsProps().settings, saving()]);

  const reloadLatest = () => {
    retainedSaveError.current = false; setSaveError(undefined);
    setDraft(structuredClone(settingsProps().settings));
    setBaselineValue(structuredClone(settingsProps().settings));
    setMcpDrafts([]);
    setAgentDrafts(structuredClone(agentConfig()?.agents ?? []));
    setHasAgentConfigDraft(agentConfig() !== undefined);
    setBaselineAgentConfig(agentEditsSnapshot(agentConfig()));
    setBaselineAgentRevision(agentConfig()?.revision);
    incomingAgentConfigRef.current = JSON.stringify([agentConfigSnapshot(), agentConfig()?.revision]);
    setSettingsConflict(false); setAgentsConflict(false);
  };

  createDependencyEffect(() => {
    const capturedSettingsProps = { ...settingsProps() }; const capturedDirty = dirty();
 capturedSettingsProps.onDirtyChange?.(capturedDirty);

 return () => capturedSettingsProps.onDirtyChange?.(false); }, () => [dirty(), currentSnapshot(), saving(), settingsProps().onDirtyChange]);
  createDependencyEffect(() => {
    const capturedDirty = dirty();

 if (capturedDirty) setSaved(false); }, () => [dirty()]);
  createDependencyEffect(() => { if (!retainedSaveError.current) setSaveError(undefined); }, () => [currentSnapshot()]);

  const applyIncomingAgents = (config?: AgentConfig) => {
    const next = config ? structuredClone(config) : undefined;
    const agents = next?.agents ?? [];
    const selectedName = agentDrafts()[agentIndex()]?.name;
    const selectedIndex = agents.findIndex(item => item.name === selectedName);
    setHasAgentConfigDraft(next !== undefined);
    setMcpDrafts([]);
    setAgentDrafts(agents);
    setAgentIndex(selectedIndex >= 0 ? selectedIndex : firstAgentIndex(agents));
    setBaselineAgentConfig(agentEditsSnapshot(next));
    setBaselineAgentRevision(next?.revision);
  };

  createDependencyEffect(() => { const capturedAgentConfigSnapshot = agentConfigSnapshot(); const capturedAgentConfigDirty = agentConfigDirty(); const capturedAgentConfig = agentConfig();

    const incoming = JSON.stringify([capturedAgentConfigSnapshot, capturedAgentConfig?.revision]);

    if (saving() || incomingAgentConfigRef.current === incoming) return;
    incomingAgentConfigRef.current = incoming;

    if (capturedAgentConfigDirty) {
      if (capturedAgentConfigSnapshot === baselineAgentConfig()) setBaselineAgentRevision(capturedAgentConfig?.revision);
      else setAgentsConflict(true);

      return;
    }

    applyIncomingAgents(capturedAgentConfig);
  }, () => [agentConfigDirty(), agentConfig(), agentConfigSnapshot(), saving()]);
  const patch = (value: Partial<AppSettings>) => setDraft((current) => ({ ...current, ...value }));
  const [capErrors, setCapErrors] = createSignal<Record<string, string>>({});

  const capError = (key: string) => (error: string | undefined) => setCapErrors(current => {
    if (current[key] === error) return current;
    const { [key]: _removed, ...rest } = current;

    return error === undefined ? rest : { ...rest, [key]: error };
  });

  const setModelCap = (model: string, cap: number | null | undefined) => setDraft(current => {
    const { [model]: _removed, ...rest } = current.modelContextWindowCaps;

    return { ...current, modelContextWindowCaps: cap === undefined ? rest : { ...rest, [model]: cap } };
  });

  const save = async () => {
    if (conflict()) return;
    const capturedDirty = dirty(); const capturedSettingsProps = { ...settingsProps() }; const capturedDraft = structuredClone(draft()); const capturedBaseline = structuredClone(baselineValue()); const capturedAgentConfigDirty = agentConfigDirty(); const capturedCurrentAgentConfig = currentAgentConfig(); const capturedCurrentSnapshot = currentSnapshot();

 if (savingRef.current || !capturedDirty) return; savingRef.current = true; retainedSaveError.current = false; setSaving(true); setSaveError(undefined);

 try { await capturedSettingsProps.onSave(capturedDraft, capturedAgentConfigDirty ? capturedCurrentAgentConfig : undefined, capturedBaseline); setBaselineValue(structuredClone(capturedDraft)); setSaveRevision(value => value + 1);

 if (capturedAgentConfigDirty) setBaselineAgentConfig(agentEditsSnapshot(capturedCurrentAgentConfig)); setSaved(currentSnapshotRef.current === capturedCurrentSnapshot); window.setTimeout(() => setSaved(false), 1600); } catch (reason) {
   recordSaveFailure(reason instanceof Error ? reason : new Error((reason instanceof Error ? reason.message : String(reason))), capturedAgentConfigDirty, capturedCurrentAgentConfig);
 } finally { if (capturedAgentConfigDirty) setBaselineAgentRevision(capturedCurrentAgentConfig?.revision); savingRef.current = false; setSaving(false); } };

  const recordSaveFailure = (reason: Error, agentsChanged: boolean, configuration?: AgentConfig) => {
    retainedSaveError.current = reason instanceof SettingsSaveError || reason instanceof ClientPreferenceConflictError;

    if (reason instanceof SettingsSaveError && agentsChanged) setBaselineAgentConfig(agentEditsSnapshot(configuration));

    if (reason instanceof ClientPreferenceConflictError) setSettingsConflict(true);

    if (reason instanceof SettingsSaveError && reason.conflict) setSettingsConflict(true);
    setSaveError(reason.message);
  };

  const nextAgentSuffixRef = createRef(agentDrafts().length);
  const addHost = () => setDraft((current) => ({ ...current, hosts: [...current.hosts, { id: uid("host"), enabled: true, name: "New host", target: "", piPath: "piopd" }] }));
  const updateHost = (id: string, value: Partial<RemoteHost>) => setDraft((current) => ({ ...current, hosts: current.hosts.map((host) => host.id === id ? { ...host, ...value } : host) }));
  const [hostToRemove, setHostToRemove] = createSignal<RemoteHost>();
  const removeHost = (host: RemoteHost) => setHostToRemove(host);

  const confirmRemoveHost = (host: RemoteHost) => {
    setDraft((current) => ({ ...current, hosts: current.hosts.filter((item) => item.id !== host.id) }));
    setHostToRemove(undefined);
  };

  const agent = createMemo(() => (agentDrafts()[agentIndex()]));
  const agentFastModeEnabled = createMemo(() => (agent()?.fastMode ?? draft().defaultFastMode));
  const updateAgent = (value: Partial<AgentProfile>) => setAgentDrafts((current) => current.map((item, index) => index === agentIndex() ? { ...item, ...value } : item));

  /** Changes one agent name in every agent's subagent and peer allowlists. A missing name removes it. */
  const renamedAccess = (items: AgentProfile[], from: string, to?: string) => items.map(item => {
    const rename = (access: AgentAccess | undefined) => Array.isArray(access) && access.includes(from) ? access.flatMap(name => name !== from ? [name] : to ? [to] : []) : access;

    const subagents = rename(item.allowed_subagents); const peers = rename(item.allowed_peers);

    return subagents === item.allowed_subagents && peers === item.allowed_peers ? item : { ...item, allowed_subagents: subagents, allowed_peers: peers };
  });

  const renameAgent = (name: string) => { if (!agent() || (!isBuiltInAgent(agent()) && name.trim().toLowerCase() === "general")) return;

  const previous = agent().name; updateAgent({ name }); setAgentDrafts(current => renamedAccess(current, previous, name)); };

  const defaultAgentName = createMemo(() => agentDrafts().find(item => item.isDefault)?.name);
  const setDefaultAgent = (name: string) => setAgentDrafts(current => current.map(({ isDefault: _isDefault, ...item }) => item.name === name ? { ...item, isDefault: true } : item));

  const addAgent = () => { if (!agentConfig() || saving()) return; let suffix = nextAgentSuffixRef.current;

  while (agentDrafts().some((item) => item.name.toLowerCase() === `agent-${suffix}`)) suffix += 1; nextAgentSuffixRef.current = suffix + 1; const next: AgentProfile = { name: `agent-${suffix}`, model: "", effort: "", path_systemprompt: "~/.agents/prompts/system/default.md", path_agent_prompt: "", tools: [...(agentDrafts().find(isBuiltInAgent)?.tools ?? [])], skills: [], mcpServers: {} }; setAgentDrafts((current) => [...current, next]); setAgentIndex(agentDrafts().length - 1); };

  const removeAgent = () => { if (!agent() || isBuiltInAgent(agent())) return;

  const removedDefault = agent().isDefault; const next = renamedAccess(agentDrafts().filter((_, index) => index !== agentIndex()), agent().name).map(item => removedDefault && isBuiltInAgent(item) ? { ...item, isDefault: true } : item); setMcpDrafts(current => Array.from(current).filter((_, index) => index !== agentIndex())); setAgentDrafts(next); setAgentIndex(firstAgentIndex(next)); };

  const agentLevels = (item: AgentProfile) => {
    const model = settingsProps().models.find((model) => `${model.provider}/${model.id}` === (item.model));
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    if (!model) return levels;

    if (!model.reasoning) return ["off"];

    return levels.filter((level) => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
  };

  const hostFastModelSnapshot = createMemo(() => hostFastModels(settingsProps().providerHostId)());
  const supportsFastMode = (model: string) => !rejectsFastMode(hostFastModelSnapshot(), model);

  const modelCatalog = createMemo(() => {
    const availableModelIds = new Set(settingsProps().models.map((model) => `${model.provider}/${model.id}`));
    const hiddenModels = new Set(draft().hiddenModels);
    const modelChoices = [...settingsProps().models.map((model) => ({ id: `${model.provider}/${model.id}`, name: (model.name || model.id), contextWindow: model.contextWindow }))];

    return { availableModelIds, hiddenModels, modelChoices };
  });

  const filteredModelChoices = createMemo(() => {
    const query = modelFilter().trim().toLocaleLowerCase();
    const { modelChoices, hiddenModels } = modelCatalog();

    return modelChoices
      .filter((model) => `${draft().modelAliases?.[model.id] ?? ""} ${model.name} ${model.id}`.toLocaleLowerCase().includes(query))
      .sort((left, right) => Number(hiddenModels.has(left.id)) - Number(hiddenModels.has(right.id)));
  });

  const validateAgentResources = () => {
    const { availableModelIds, hiddenModels, modelChoices } = modelCatalog();
    const modelDiscoveryUnavailable = settingsProps().models.length === 0;
    const thinkingDiscoveryUnavailable = modelDiscoveryUnavailable;
    const agentsValid = !agentConfig() || (agentDrafts().some(isBuiltInAgent) && agentDrafts().every((item) => agentProfileSchema.safeParse(item).success && item.name.length > 0 && !!item.path_systemprompt?.trim() && (!item.model || modelDiscoveryUnavailable || availableModelIds.has(item.model)) && (!item.effort || thinkingDiscoveryUnavailable || agentLevels(item).includes(item.effort))) && new Set(agentDrafts().map((item) => item.name)).size === agentDrafts().length);
    const defaultAgentValid = !agentConfig() || agentDrafts().filter((item) => item.isDefault).length === 1;
    const invalidHost = draft().hosts.find((host) => !host.name.trim() || !host.target.trim() || !host.piPath.trim());

    return { availableModelIds, hiddenModels, modelChoices, modelDiscoveryUnavailable, thinkingDiscoveryUnavailable, agentsValid, defaultAgentValid, invalidHost };
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
    const contextWindowValid = capRangeError(draft().contextWindowCap) === undefined;

    const duplicateNames = <T extends { name: string }>(items: T[]) => { const counts = new Map<string, number>(); items.forEach((item) => { const name = item.name.trim().toLowerCase();

    if (name) counts.set(name, (counts.get(name) ?? 0) + 1); });

    return new Set([...counts].flatMap(([name, count]) => count > 1 ? [name] : [])); };

    const duplicateHostNames = duplicateNames(draft().hosts);
    const reservedLocalHostName = draft().hosts.some((host) => host.name.trim().toLowerCase() === "local");
    const duplicateAgentNames = duplicateNames(agentDrafts());
    const invalidAgentModel = agentValidation().modelDiscoveryUnavailable ? undefined : agentDrafts().find((item) => item.model && !agentValidation().availableModelIds.has(item.model));
    const invalidAgentEffort = agentValidation().thinkingDiscoveryUnavailable ? undefined : agentDrafts().find((item) => item.effort && !agentLevels(item).includes(item.effort));
    const emptyAgent = agentDrafts().find((item) => !item.name.trim());
    const missingAgentPrompt = agentDrafts().find((item) => !item.path_systemprompt?.trim());

    return { contextWindowValid, duplicateNames, duplicateHostNames, reservedLocalHostName, duplicateAgentNames, invalidAgentModel, invalidAgentEffort, emptyAgent, missingAgentPrompt };
  };

  const nameValidation = createMemo(() => (validateSettingsNames()));

  const validationError = createMemo(() => (firstValidationError([
    () => mcpError(),
    () => agentValidation().defaultAgentValid ? undefined : "Pick one default agent",
    () => nameValidation().contextWindowValid ? undefined : capRangeError(draft().contextWindowCap, "General context cap"),
    () => Object.entries(capErrors()).map(([label, error]) => label + ": " + error)[0],
    () => draft().hosts.length > 16 ? "At most 16 remote hosts can be configured" : undefined,
    () => nameValidation().reservedLocalHostName ? "The host name “Local” is reserved for this host" : undefined,
    () => nameValidation().duplicateHostNames.size ? `Host name “${[...nameValidation().duplicateHostNames][0]}” is used more than once` : undefined,
    () => agentValidation().invalidHost ? `${required((agentValidation().invalidHost)).name.trim() || "Host"}: name, SSH target, and Pi executable are required` : undefined,
    () => shortcutValidation().error,
    () => shortcutValidation().duplicateShortcuts.size ? `Shortcut “${[...shortcutValidation().duplicateShortcuts][0]}” is assigned more than once` : undefined,
    () => !agentDrafts().some(isBuiltInAgent) && agentConfig() ? "The built-in general agent is required" : undefined,
    () => nameValidation().emptyAgent ? "Agent name is required" : undefined,
    () => nameValidation().duplicateAgentNames.size ? `Agent name “${[...nameValidation().duplicateAgentNames][0]}” is used more than once` : undefined,
    () => nameValidation().invalidAgentModel ? `${required((nameValidation().invalidAgentModel)).name}: model is unavailable: ${required((nameValidation().invalidAgentModel)).model}` : undefined,
    () => nameValidation().invalidAgentEffort ? `${required((nameValidation().invalidAgentEffort)).name}: effort is unavailable: ${required((nameValidation().invalidAgentEffort)).effort}` : undefined,
    () => nameValidation().missingAgentPrompt ? `${required((nameValidation().missingAgentPrompt)).name}: system prompt file is required. Set it in Settings → Agents; for an older profile, restart Piop to migrate its prompt.` : undefined,
    () => !agentValidation().agentsValid ? "Every agent needs a unique name and valid resources" : undefined
  ])));

  const validateForm = () => {
    const invalidFastModeAgent = agentDrafts().find((item) => item.fastMode === true && !supportsFastMode(item.model));
    const fastModeValidationError = invalidFastModeAgent ? `${invalidFastModeAgent.name}: model ${invalidFastModeAgent.model} does not support fast mode` : undefined;
    const formValid = agentValidation().agentsValid && !validationError() && !fastModeValidationError;
    const searchTerms = settingsQuery().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matchingSections = (settingsProps().scope === "client" ? visibleClientSections(debugView(settingsProps().settings).toastHistory) : daemonSections(settingsProps().providerHostId ?? "local")).filter((item) => searchTerms.every((term) => item.label.toLocaleLowerCase().includes(term)));
    const selectedSection = settingsProps().selectedSection === "toasts" && !debugView(settingsProps().settings).toastHistory ? "keybinds" : settingsProps().selectedSection;
    const visibleSection = selectedSection ?? (matchingSections.some((item) => item.id === section()) ? section() : matchingSections[0]?.id);

    return { invalidFastModeAgent, fastModeValidationError, formValid, searchTerms, matchingSections, visibleSection };
  };

  const formFields = createMemoFields(validateForm);
  const formValidation = () => formFields;

  const renderSettingsHeader = () => {
    const renderSaveControls = () => {
      const renderDiscardChanges = () => (dirty() && !saving() && <button class="discard-button" onClick={reloadLatest}><X size={15} />Discard changes</button>);
      const renderPendingSettingsCount = () => (settingsProps().pendingSettingsCount > 0 && !dirty() && <small role="status">Saved · waiting for {settingsProps().pendingSettingsCount} session{settingsProps().pendingSettingsCount === 1 ? "" : "s"} to apply changes</small>);
      const renderSaveButton = () => (conflict() ? <small role="alert">{saveError() || "Settings changed in another window."} <button disabled={saving()} onClick={reloadLatest}>Reload latest settings and discard local edits</button></small> : (saveError() || validationError() || formValidation().fastModeValidationError || durabilityError()) && <small role="alert">{saveError() || validationError() || formValidation().fastModeValidationError || durabilityError()}</small>);

      const renderSaveButtonLabel = () => {
        const renderSaveStatus = () => (saved() && !dirty() ? <Check size={15} /> : <Save size={15} />);
        const renderSaveLabel = () => saveLabel();

        return (<button class={dirty() && !saving() && formValidation().formValid ? "primary-button needs-save" : "primary-button"} disabled={saving() || conflict() || !dirty() || !formValidation().formValid} onClick={() => void save()}>{renderSaveStatus()}{renderSaveLabel()}</button>);
      };

      return (<div class="settings-save">{renderDiscardChanges()}{renderPendingSettingsCount()}{renderSaveButton()}{renderSaveButtonLabel()}</div>);
    };

    return (<header class="settings-header"><div><h1>{settingsProps().scope === "client" ? "Client settings" : settingsProps().daemonLabel + " settings"}</h1></div>{renderSaveControls()}</header>);
  };

  const renderSettingsLayout = () => {
    const renderSettingsContent = () => {


      const renderGeneral = () => (formValidation().visibleSection === "general" && <SettingsSection title="General" description="Agent behavior.">
        <SettingRow icon={<CircleGauge />} title="Default context window cap" description="Used when no /cap choice, agent cap, or model cap applies. Off uses each model's full window. Open conversations update when idle."><div class="setting-cap-controls"><input class="setting-number" aria-label="Context window cap" aria-invalid={!nameValidation().contextWindowValid} disabled={!draft().contextWindowCapEnabled} type="number" min={100000} max={50000000} step={1000} value={draft().contextWindowCap} onInput={(event) => patch({ contextWindowCap: Number(event.target.value) })} /><Toggle label="Enable context window cap" checked={draft().contextWindowCapEnabled} onChange={(contextWindowCapEnabled) => patch({ contextWindowCapEnabled })} /></div></SettingRow>
        <SettingRow icon={<ShieldCheck />} title="Automatic retry" description="Retry transient provider and network errors."><Toggle label="Automatic retry" checked={draft().autoRetry} onChange={(autoRetry) => patch({ autoRetry })} /></SettingRow>
        <div class="general-agent-default">
          <label class="field"><span>Default agent</span><select aria-label="Default agent" disabled={!agentConfig()} value={defaultAgentName() ?? ""} onChange={(event) => setDefaultAgent(event.target.value)}>{<Key each={agentDrafts()} by={(item) => item.name}>{(item, _index) => <option  value={item().name}>{item().name}</option>}</Key>}</select></label>
        </div>
      </SettingsSection>);

      const renderModels = () => (formValidation().visibleSection === "inference" && inferenceView() === "models" && <SettingsSection title="Models" description="Set model aliases and choose which models appear in chat pickers. Saved aliases apply immediately. Clear an alias to restore the original name. Newly arrived models start hidden." headerAction={<label class="section-filter"><Search size={14} /><input aria-label="Filter models" placeholder="Filter by name or provider" value={modelFilter()} onInput={(event) => setModelFilter(event.target.value)} /></label>}>
        <div class="model-bulk-actions" role="group" aria-label="All model visibility">
          <button type="button" class="section-toggle-all" disabled={saving() || !agentValidation().modelChoices.some(model => agentValidation().hiddenModels.has(model.id))} onClick={() => patch({ hiddenModels: draft().hiddenModels.filter(id => !agentValidation().availableModelIds.has(id)) })}>Enable all models</button>
          <button type="button" class="section-toggle-all" disabled={saving() || !agentValidation().modelChoices.some(model => !agentValidation().hiddenModels.has(model.id))} onClick={() => patch({ hiddenModels: [...new Set([...draft().hiddenModels, ...agentValidation().modelChoices.map(model => model.id)])] })}>Disable all models</button>
        </div>
        {settingsProps().loadingModels.length > 0 && <p class="empty-small" role="status">Loading models from {settingsProps().loadingModels.join(", ")}…</p>}
        <div class="config-list">{<Key each={filteredModelChoices()} by={(model) => model.id}>{(model, _index) => { const [editingAlias, setEditingAlias] = createSignal(false); const [editingCap, setEditingCap] = createSignal(false); createDependencyEffect(() => { setEditingAlias(false); setEditingCap(false); }, () => [saveRevision()]); return <div class="config-row model-row" ><button type="button" class="config-icon model-alias-toggle" aria-label={`Edit alias for ${model().id}`} aria-expanded={editingAlias()} onClick={() => setEditingAlias(value => !value)}><Pencil size={16} /></button><span><span class="model-label"><Show when={editingAlias()} fallback={<Show when={draft().modelAliases?.[model().id]}>{alias => <strong>{alias()}</strong>}</Show>}><input ref={element => queueMicrotask(() => { if (element.isConnected) element.focus(); })} class="model-alias" aria-label={`Alias for ${model().id}`} placeholder="Alias" value={draft().modelAliases?.[model().id] ?? ""} onInput={event => patch({ modelAliases: { ...draft().modelAliases, [model().id]: event.currentTarget.value } })} /></Show><strong classList={{ "model-id": !!draft().modelAliases?.[model().id] }}>{draft().modelAliases?.[model().id] ? `(${model().id})` : model().id}</strong></span><Show when={!agentValidation().availableModelIds.has(model().id)}><small>Currently unavailable</small></Show></span><span class="model-cap-controls"><button type="button" class="config-icon model-cap-toggle" aria-label={`Edit context cap for ${model().id}`} title="Edit context cap" aria-expanded={editingCap()} onClick={event => { const controls = event.currentTarget.parentElement; const opening = !editingCap(); setEditingCap(opening); if (opening) queueMicrotask(() => { if (controls?.isConnected) controls.querySelector("input")?.focus(); }); }}><CircleGauge size={16} /></button><span hidden={!editingCap()}><CapInput label={`Context cap for ${model().id}`} placeholder="Inherit cap" value={draft().modelContextWindowCaps[model().id]} onChange={cap => setModelCap(model().id, cap)} onError={capError(`Context cap for ${model().id}`)} /></span></span><small class="model-context">Context: {model().contextWindow ? `${Math.floor(model().contextWindow! / 1000) >= 1000 ? `${Math.floor(model().contextWindow! / 1000) / 1000}m` : `${Math.floor(model().contextWindow! / 1000)}k`}` : "Unknown"}</small><Toggle label={`Show ${model().id}`} checked={!agentValidation().hiddenModels.has(model().id)} onChange={(visible) => setDraft((current) => ({ ...current, hiddenModels: visible ? current.hiddenModels.filter((id) => id !== model().id) : [...current.hiddenModels, model().id] }))} /></div>; }}</Key>}</div>
        {!filteredModelChoices().length && (agentValidation().modelChoices.length > 0 || settingsProps().loadingModels.length === 0) && <div class="empty-small">{agentValidation().modelChoices.length ? "No models match your search." : "No models available. Sign in to a provider to see its models."}</div>}
      </SettingsSection>);

      const renderAgents = () => {
        const renderAgentEditor = () => {
          const renderAgentFields = () => {
            const renderAgentNameRow = () => (<div class="agent-name-row"><label class="field"><span>Agent name</span><input aria-label="Agent name" aria-invalid={!isBuiltInAgent(agent()) && (!agent().name.trim() || agent().name.trim().toLowerCase() === "general" || nameValidation().duplicateAgentNames.has(agent().name.trim().toLowerCase()))} disabled={isBuiltInAgent(agent())} value={agent().name} onInput={(event) => { renameAgent(event.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, "")); event.currentTarget.value = agent().name; }} /></label><IconButton label={`Remove ${agent().name}`} disabled={isBuiltInAgent(agent())} onClick={removeAgent}><Trash2 size={15} /></IconButton></div>);

            const renderAgentDefaults = () => {
              const renderAgentModel = () => (<label class="field"><span>Default model</span><select aria-label="Agent default model" value={agent().model} onChange={(event) => updateAgent({ model: event.target.value })}><option value="">Use session model</option>{agent().model && !agentValidation().availableModelIds.has(agent().model) && <option value={agent().model} disabled>Unavailable: {agent().model}</option>}{<Key each={settingsProps().models} by={(model) => `${model.provider}/${model.id}`}>{(model, _index) => <option  value={`${model().provider}/${model().id}`}>{draft().modelAliases?.[`${model().provider}/${model().id}`] || model().name || model().id}</option>}</Key>}</select></label>);
              const renderAgentFastMode = () => (<div class="field general-fast-mode" data-tooltip={agent().fastMode === undefined ? "Using the fallback fast mode setting" : "Fast mode default for this agent"}><span>Fast mode</span><div><button type="button" class={`fast-mode-indicator${agentFastModeEnabled() ? " active" : ""}`} aria-label="Agent fast mode" aria-description={agent().fastMode === undefined ? "Using fallback setting" : agentFastModeEnabled() ? "Fast mode on" : "Fast mode off"} aria-pressed={agentFastModeEnabled()} aria-invalid={agent().fastMode === true && !supportsFastMode(agent().model)} onClick={() => updateAgent({ fastMode: !agentFastModeEnabled() })}><Zap size={22} strokeWidth={1.5} fill={agentFastModeEnabled() ? "currentColor" : "none"} aria-hidden="true" /></button></div></div>);
              const renderAgentEffort = () => (<label class="field"><span>Default effort</span><select aria-label="Agent default effort" aria-invalid={Boolean(!agentValidation().thinkingDiscoveryUnavailable && agent().effort && !agentLevels(agent()).includes(agent().effort))} value={agent().effort} onChange={(event) => updateAgent({ effort: event.target.value })}><option value="">Use fallback ({draft().defaultThinking})</option>{agent().effort && !agentLevels(agent()).includes(agent().effort) && <option value={agent().effort} disabled>Unavailable: {agent().effort}</option>}{<Key each={agentLevels(agent())} by={(level) => level}>{(level, _index) => <option  value={level()}>{level().charAt(0).toUpperCase() + level().slice(1)}</option>}</Key>}</select></label>);

              const renderAgentContextCap = () => (<label class="field"><span>Context cap</span><CapInput label="Agent context cap" placeholder="Inherit" value={agent().contextWindowCap} onChange={contextWindowCap => updateAgent({ contextWindowCap })} onError={capError("Agent context cap")} /></label>);

              return (<div class="agent-defaults">{renderAgentModel()}{renderAgentFastMode()}{renderAgentEffort()}{renderAgentContextCap()}</div>);
            };

            const renderAgentPromptFiles = () => (<label class="field"><span>System prompt file</span><input aria-label="System prompt file" aria-invalid={!agent().path_systemprompt?.trim()} placeholder="Path relative to agent config.json, or absolute path" value={agent().path_systemprompt ?? ""} onInput={(event) => updateAgent({ path_systemprompt: event.target.value })} /></label>);

            return (<Show when={agent()}><div class="agent-fields">{renderAgentNameRow()}
              <label class="field"><span>Description</span><textarea class="agent-description" aria-label="Agent description" maxLength={500} rows={2} placeholder="What this agent is for. Other agents see it when they choose an agent to start." value={agent().description ?? ""} onInput={(event) => updateAgent({ description: event.currentTarget.value || undefined })} /></label>
              {renderAgentDefaults()}
              <div class="agent-usage"><div class="agent-usage-option"><span>Usable as subagent</span><Toggle label="Usable as subagent" checked={agent().allow_as_subagent !== false} onChange={allow_as_subagent => updateAgent({ allow_as_subagent })} /></div><div class="agent-usage-option"><span>Usable as peer</span><Toggle label="Usable as peer" checked={agent().allow_as_peer !== false} onChange={allow_as_peer => updateAgent({ allow_as_peer })} /></div></div>
              {renderAgentPromptFiles()}<label class="field"><span>Agent prompt file</span><input aria-label="Agent prompt file" placeholder="Optional path to an agent prompt file" value={agent().path_agent_prompt ?? ""} onInput={(event) => updateAgent({ path_agent_prompt: event.target.value })} /></label>
              <AgentExtensions paths={agent().extensions ?? []} onChange={extensions => updateAgent({ extensions })} />
              <AgentAllowlist title="Tools" query={toolQuery()} onQuery={setToolQuery} titleAction={<><RefreshTools hostId={providerHostId()} onChange={tools => patch({ tools })} /><button type="button" class="agent-codemode" data-mode={agent().codemode ?? "on"} aria-label={"Codemode " + (agent().codemode ?? "on").toUpperCase()} data-tooltip={CODEMODE_HINTS[agent().codemode ?? "on"]} onClick={() => updateAgent({ codemode: NEXT_CODEMODE[agent().codemode ?? "on"] })}>Codemode {(agent().codemode ?? "on").toUpperCase()}</button></>}><AgentTools tools={draft().tools} query={toolQuery()} selected={agent().tools} agent={agent()} agentNames={agentDrafts().map(item => item.name)} onChange={tools => updateAgent({ tools })} onLimitsChange={updateAgent} /></AgentAllowlist><AgentAllowlist title="Skills" query={skillQuery()} onQuery={setSkillQuery} titleAction={<RefreshSkills hostId={providerHostId()} skills={draft().skills} onChange={skills => patch({ skills })} />}><AgentSkills skills={draft().skills} query={skillQuery()} selected={agent().skills} onChange={skills => updateAgent({ skills })} /></AgentAllowlist><McpSettings value={agent().mcpServers} draft={mcpDrafts()[agentIndex()]} onDraft={value => setMcpDrafts(current => agentDrafts().map((_, index) => index === agentIndex() ? value : current[index]))} onChange={mcpServers => updateAgent({ mcpServers })} />
            </div></Show>);
          };

          return (<>{!agentConfig() && <p role={settingsProps().resourceError ? "alert" : "status"}>{settingsProps().resourceError ? "Could not load agent definitions: " + required((settingsProps().resourceError)) : "Loading agent definitions…"}</p>}
          <div class="agent-editor"><div class="agent-list">{<Index each={agentDrafts()}>{(item, index) => <button  class={index === agentIndex() ? "active" : ""} onClick={() => setAgentIndex(index)}><Bot size={14} /><span>{item().name}</span></button>}</Index>}</div>
            {renderAgentFields()}
          </div></>);
        };

        return (formValidation().visibleSection === "agents" && <SettingsSection title="Agents" description="Choose defaults, instructions, and the resources each agent may see." headerAction={<button class="secondary-button" disabled={!agentConfig() || saving()} onClick={addAgent}><CirclePlus size={15} />Add agent</button>}>
          {renderAgentEditor()}
        </SettingsSection>);
      };

      return (<section class="settings-content">
        <Show when={formValidation().visibleSection === "toasts"}><ToastHistory /></Show>
        {formValidation().visibleSection === "plugins" && <PluginSettings hostId={providerHostId()} onBusyChange={settingsProps().onSavingChange} />}
        {!formValidation().matchingSections.length && <div class="empty-small" role="status">No settings match your search.</div>}
        {formValidation().visibleSection === "inference" && <div class="segmented-control" role="group" aria-label="Inference view">{(["models", "providers"] as const).map(view => <button type="button" aria-pressed={inferenceView() === view} onClick={() => setInferenceView(view)}>{view === "models" ? "Models" : "Providers"}</button>)}</div>}
        {formValidation().visibleSection === "inference" && inferenceView() === "providers" && <Rerun on={providerHostId}>{(_key) => <ProviderSettings  hosts={settingsProps().providerHosts ?? settingsProps().settings.hosts} initialHostId={settingsProps().providerHostId} fixedHost />}</Rerun>}
        {renderGeneral()}
        {renderModels()}
        {formValidation().visibleSection === "connections" && <SettingsSection title="Anchor host" description="This device connects to one host. You can use the hosts that this host has added."><button class="secondary-button" disabled={dirty() || saving()} onClick={() => window.dispatchEvent(new Event("piop-mobile-disconnect"))}>Change anchor host</button>{dirty() && <p>Save your changes before switching hosts.</p>}</SettingsSection>}
        {renderAgents()}
        <For each={pluginSettingsSections}>{item => <Show when={formValidation().visibleSection === item.section}><SettingsSection title={item.label} description={item.description}><Dynamic component={item.component} settings={draft()} agents={agentDrafts()} onChange={patch} /></SettingsSection></Show>}</For>
        {formValidation().visibleSection === "storage" && <StorageSettings hostId={settingsProps().providerHostId} />}
        {formValidation().visibleSection === "hosts" && <SettingsSection title="Hosts" description="Connect to Piop daemons over SSH. Sessions and configuration stay on each host."><div class="mcp-list"><div class="mcp-card"><div class="mcp-card-head"><span class="config-icon mcp"><Server size={16} /></span><strong>Local</strong><Toggle label="Enable local host" checked={draft().localEnabled !== false} onChange={(localEnabled) => setDraft((current) => ({ ...current, localEnabled }))} /></div></div>{<Key each={draft().hosts} by={(host) => host.id}>{(host, _index) => <div class="mcp-card" ><div class="mcp-card-head"><span class="config-icon mcp"><Server size={16} /></span><input aria-label="Host name" aria-invalid={!host().name.trim() || host().name.trim().toLowerCase() === "local" || nameValidation().duplicateHostNames.has(host().name.trim().toLowerCase())} value={host().name} onInput={(event) => updateHost(host().id, { name: event.target.value })} /><Toggle label={`Enable ${host().name}`} checked={host().enabled !== false} onChange={(enabled) => updateHost(host().id, { enabled })} /><IconButton label={`Remove ${host().name}`} onClick={() => removeHost(host())}><Trash2 size={15} /></IconButton></div><div class="command-fields"><label><span>SSH target</span><input aria-label={`${host().name} SSH target`} aria-invalid={!host().target.trim()} placeholder="user@example.com" value={host().target} onInput={(event) => updateHost(host().id, { target: event.target.value })} /></label><label><span>Piop daemon executable</span><input aria-label={`${host().name} Piop daemon executable`} aria-invalid={!host().piPath.trim()} placeholder="piopd" value={host().piPath === "pi" ? "piopd" : host().piPath.endsWith("/pi") ? `${host().piPath.slice(0, -2)}piopd` : host().piPath} onInput={(event) => updateHost(host().id, { piPath: event.target.value })} /></label></div></div>}</Key>}</div><button class="secondary-button" disabled={draft().hosts.length >= 16} onClick={addHost}><CirclePlus size={15} />Add host</button></SettingsSection>}
        {formValidation().visibleSection === "keybinds" && <SettingsSection title="Keybinds" description="Customize global application shortcuts."><div class="keybind-list">{<Key each={keybindDefinitions} by={(binding) => binding.action}>{(binding, _index) => <label class="keybind-row" ><span><strong>{binding().label}</strong><small>{binding().description}</small></span><KeybindInput action={binding().action} value={draft().keybindings[binding().action]} invalid={shortcutValidation().duplicateShortcuts.has(draft().keybindings[binding().action].trim().toLowerCase())} onChange={(shortcut) => setDraft((current) => ({ ...current, keybindings: { ...current.keybindings, [binding().action]: shortcut } }))} /></label>}</Key>}</div><button class="secondary-button" onClick={() => patch({ keybindings: { ...defaultKeybindings } })}><RotateCcw size={15} />Restore defaults</button></SettingsSection>}

      </section>);
    };

    return (<div class={settingsProps().embedded ? "settings-layout settings-layout-embedded" : "settings-layout"}>{!settingsProps().embedded && <nav class="settings-nav"><label class="search settings-search"><Search size={15} /><input autofocus type="search" aria-label="Search settings" placeholder="Search settings" value={settingsQuery()} onInput={(event) => setSettingsQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSettingsQuery(""); } }} /></label>{<Key each={formValidation().matchingSections} by={(item) => item.id}>{(item, _index) => <button  class={formValidation().visibleSection === item().id ? "active" : ""} aria-current={formValidation().visibleSection === item().id ? "page" : undefined} onClick={() => setSection(item().id)}><Dynamic component={item().icon} size={16} /><span>{item().label}</span></button>}</Key>}</nav>}
      {renderSettingsContent()}</div>);
  };

  const renderSettingsSaveFab = () => (dirty() && pastHeader() && <div class="settings-save-fab"><button class={dirty() && !saving() && formValidation().formValid ? "primary-button needs-save" : "primary-button"} disabled={saving() || conflict() || !dirty() || !formValidation().formValid} onClick={() => void save()}><Save size={15} />{saveLabel()}</button></div>);

  return <main class={dirty() ? "settings-shell has-unsaved" : "settings-shell"}>{renderSettingsHeader()}
    {renderSettingsLayout()}
    {renderSettingsSaveFab()}
    <Show when={hostToRemove()}>{(host) => <RemoveHostDialog name={host().name} onCancel={() => setHostToRemove(undefined)} onRemove={() => confirmRemoveHost(host())} />}</Show>
  </main>;
}

function SettingsSection(componentProps: { title: string; description: string; headerAction?: JSXElement; children: JSXElement }) { return <div class="settings-section"><div class="section-title"><div><h2>{componentProps.title}</h2><p>{componentProps.description}</p></div>{componentProps.headerAction}</div>{componentProps.children}</div>; }

function AgentAllowlist(componentProps: { title: string; titleAction?: JSXElement; query: string; onQuery: (query: string) => void; children: JSXElement }) {
  return <fieldset class="agent-allowlist"><legend><span>{componentProps.title}</span>{componentProps.titleAction}<span class="agent-allowlist-line" /><label class="agent-allowlist-search"><Search size={14} aria-hidden="true" /><input type="search" placeholder="Search" aria-label={`Search ${componentProps.title.toLowerCase()}`} value={componentProps.query} onInput={event => componentProps.onQuery(event.currentTarget.value)} /></label></legend><div>{componentProps.children}</div></fieldset>;
}

function SettingRow(componentProps: { icon: JSXElement; title: string; description: string; children: JSXElement }) { return <div class="setting-row"><span class="setting-icon">{componentProps.icon}</span><span><strong>{componentProps.title}</strong><small>{componentProps.description}</small></span><div>{componentProps.children}</div></div>; }

function KeybindInput(componentProps: { action: KeybindAction; value: string; invalid?: boolean; onChange: (shortcut: string) => void }) { return <input class="keybind-input" aria-label={`${keybindDefinitions.find((item) => item.action === componentProps.action)?.label} shortcut`} aria-invalid={componentProps.invalid} value={componentProps.value} placeholder="Unassigned" readOnly onKeyDown={(event) => { if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) return; event.preventDefault(); event.stopPropagation();

if (event.key === "Backspace" || event.key === "Delete") { componentProps.onChange("");

return; }

const shortcut = shortcutFromEvent(event);

if (shortcut) componentProps.onChange(shortcut); }} />; }
