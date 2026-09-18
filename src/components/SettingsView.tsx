import { useEffect, useRef, useState } from "react";
import { Blocks, BookOpen, Bot, Check, CircleGauge, CirclePlus, Cpu, HardDrive, Keyboard, PlugZap, RotateCcw, Save, Search, Server, Settings2, ShieldCheck, Sparkles, Trash2, Wrench, Zap } from "lucide-react";
import { HooksSettings, HookIcon } from "./HooksSettings";
import { StorageSettings } from "./StorageSettings";
import type { AgentProfile, AppSettings, McpServer, Model, AgentConfig, RemoteHost, SessionSummary } from "../types";
import { uid } from "../lib/content";
import { defaultKeybindings, keybindDefinitions, shortcutFromEvent, shortcutsConflict, type KeybindAction } from "../lib/keybindings";
import { IconButton } from "./IconButton";
import { Toggle } from "./Toggle";

type Section = "general" | "models" | "storage" | "environment" | "dictionaries" | "agents" | "machines" | "keybinds" | "tools" | "skills" | "hooks" | "mcp";
const sections = [
  { id: "general" as const, label: "General", icon: Settings2 },
  { id: "models" as const, label: "Models", icon: Cpu },
  { id: "storage" as const, label: "Storage", icon: HardDrive },
  { id: "environment" as const, label: "Worktree scripts", icon: Wrench },
  { id: "keybinds" as const, label: "Keybinds", icon: Keyboard },
  { id: "machines" as const, label: "Machines", icon: Server },
  { id: "dictionaries" as const, label: "Dictionaries", icon: BookOpen },
  { id: "agents" as const, label: "Agents", icon: Bot },
  { id: "hooks" as const, label: "Hooks", icon: HookIcon },
  { id: "skills" as const, label: "Skills", icon: Sparkles }, { id: "tools" as const, label: "Tools", icon: Wrench }, { id: "mcp" as const, label: "MCP servers", icon: Blocks }
];
const isBuiltInAgent = (agent: AgentProfile) => agent.name === "general";
const firstEditableAgent = (agents: AgentProfile[]) => {
  const editableIndex = agents.findIndex((agent) => !isBuiltInAgent(agent));
  return editableIndex >= 0 ? editableIndex : agents.length ? 0 : -1;
};

function settingsSnapshot(settings: AppSettings, agentConfig?: AgentConfig) {
  const mcpServers = settings.mcpServers.map(({ status: _status, error: _error, ...server }) => server);
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable({ settings: { ...settings, mcpServers }, agentConfig }));
}

function mcpServerError(server: McpServer) {
  if (!server.name.trim()) return "Server name is required";
  if (server.startupTimeoutSec !== undefined && (!Number.isInteger(server.startupTimeoutSec) || server.startupTimeoutSec < 1 || server.startupTimeoutSec > 600)) return "Startup timeout must be a whole number between 1 and 600 seconds";
  if ((server.transport ?? "stdio") === "stdio") return server.command.trim() ? undefined : "Command is required";
  try {
    const url = new URL(server.url?.trim() ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return "URL must use HTTP or HTTPS";
  } catch { return "Enter a valid HTTP URL"; }
  if (server.headers?.trim()) {
    try {
      const headers = JSON.parse(server.headers);
      if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string")) return "Headers must be a JSON object containing string values";
    } catch { return "Headers must be valid JSON"; }
  }
  return undefined;
}

export function SettingsView({ settings, pendingSettingsCount = 0, agentConfig: incomingConfiguration, sessions = [], models = [], thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"], onSave, onDirtyChange }: { settings: AppSettings; pendingSettingsCount?: number; agentConfig?: AgentConfig; sessions?: SessionSummary[]; models?: Model[]; thinkingLevels?: string[]; onSave: (settings: AppSettings, agentConfig?: AgentConfig) => Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const [saving, setSaving] = useState(false);
  // Saving reloads extensions. Keep the last discovered capabilities until the
  // save finishes, then reconcile actual removals against the fresh discovery.
  const capabilitiesBeforeSave = useRef({ configuration: incomingConfiguration });
  if (!saving) capabilitiesBeforeSave.current = { configuration: incomingConfiguration };
  const agentConfig = saving ? capabilitiesBeforeSave.current.configuration : incomingConfiguration;
  const [draft, setDraft] = useState(() => structuredClone(settings)); const [agentDrafts, setAgentDrafts] = useState(() => structuredClone(agentConfig?.agents ?? [])); const [agentIndex, setAgentIndex] = useState(() => firstEditableAgent(agentConfig?.agents ?? [])); const [section, setSection] = useState<Section>("general"); const [saved, setSaved] = useState(false); const savingRef = useRef(false); const [saveError, setSaveError] = useState<string>(); const [skillFilter, setSkillFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [mcpTimeoutInputs, setMcpTimeoutInputs] = useState<Record<string, string>>({});
  const [pastHeader, setPastHeader] = useState(false);
  useEffect(() => {
    const onScroll = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (el && el.classList && el.classList.contains("settings-shell")) setPastHeader(el.scrollTop > 96);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);
  const baselineSettingsRef = useRef(settingsSnapshot(settings));
  const baselineAgentConfigRef = useRef(JSON.stringify(agentConfig));
  const agentConfigSnapshot = JSON.stringify(agentConfig);
  const incomingAgentConfigRef = useRef(agentConfigSnapshot);
  const [hasAgentConfigDraft, setHasAgentConfigDraft] = useState(agentConfig !== undefined);
  const currentAgentConfig = hasAgentConfigDraft ? { agents: agentDrafts.map(item => item.extensions ? { ...item, extensions: item.extensions.map(path => path.trim()).filter(Boolean) } : item), fastModeModels: agentConfig?.fastModeModels } : undefined;
  const currentSnapshot = settingsSnapshot(draft, currentAgentConfig);
  const currentSnapshotRef = useRef(currentSnapshot); currentSnapshotRef.current = currentSnapshot;
  const agentConfigDirty = JSON.stringify(currentAgentConfig) !== baselineAgentConfigRef.current;
  const dirty = settingsSnapshot(draft) !== baselineSettingsRef.current || agentConfigDirty;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, currentSnapshot, saving, onDirtyChange]);
  useEffect(() => { if (dirty) setSaved(false); }, [dirty]);
  useEffect(() => { setSaveError(undefined); }, [currentSnapshot]);
  useEffect(() => {
    // A newly discovered configuration is not a user edit. Load it without
    // replacing edits to general settings or an existing agentConfig draft.
    if (incomingAgentConfigRef.current === agentConfigSnapshot || agentConfigDirty) return;
    incomingAgentConfigRef.current = agentConfigSnapshot;
    const next = agentConfig ? structuredClone(agentConfig) : undefined;
    setHasAgentConfigDraft(next !== undefined);
    setAgentDrafts(next?.agents ?? []);
    setAgentIndex(firstEditableAgent(next?.agents ?? []));
    baselineAgentConfigRef.current = JSON.stringify(next);
  }, [agentConfigDirty, agentConfig, agentConfigSnapshot]);
  useEffect(() => { if (!agentConfig && section === "agents") setSection("general"); }, [agentConfig, section]);
  const patch = (value: Partial<AppSettings>) => setDraft((current) => ({ ...current, ...value }));
  const save = async () => { if (savingRef.current || !dirty) return; savingRef.current = true; setSaving(true); setSaveError(undefined); try { await onSave(draft, agentConfigDirty ? currentAgentConfig : undefined); baselineSettingsRef.current = settingsSnapshot(draft); if (agentConfigDirty) baselineAgentConfigRef.current = JSON.stringify(currentAgentConfig); setSaved(currentSnapshotRef.current === currentSnapshot); window.setTimeout(() => setSaved(false), 1600); } catch (reason) { setSaveError(reason instanceof Error ? reason.message : String(reason)); } finally { savingRef.current = false; setSaving(false); } };
  const nextAgentSuffixRef = useRef(agentDrafts.length);
  const addMcp = () => setDraft((current) => ({ ...current, mcpServers: [...current.mcpServers, { id: uid("mcp"), name: "New server", transport: "stdio", command: "npx", args: "", url: "", headers: "", enabled: true, status: "stopped" }] }));
  const updateMcp = (id: string, value: Partial<McpServer>) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((server) => server.id === id ? { ...server, ...value } : server) }));
  const removeMcp = (id: string) => { setDraft((current) => ({ ...current, mcpServers: current.mcpServers.filter((item) => item.id !== id) })); setAgentDrafts((current) => current.map((item) => ({ ...item, mcpServers: item.mcpServers.filter((serverId) => serverId !== id) }))); };
  const addHost = () => setDraft((current) => ({ ...current, hosts: [...current.hosts, { id: uid("host"), name: "New machine", target: "", piPath: "pi" }] }));
  const updateHost = (id: string, value: Partial<RemoteHost>) => setDraft((current) => ({ ...current, hosts: current.hosts.map((host) => host.id === id ? { ...host, ...value } : host) }));
  const removeHost = (host: RemoteHost) => {
    const count = sessions.filter((session) => session.hostId === host.id).length;
    if (settings.hosts.some((item) => item.id === host.id) && !window.confirm(`Remove ${host.name}? ${count ? `${count} indexed conversation${count === 1 ? "" : "s"} depend${count === 1 ? "s" : ""}` : "Conversations may depend"} on this machine and will become unavailable.`)) return;
    setDraft((current) => ({ ...current, hosts: current.hosts.filter((item) => item.id !== host.id) }));
  };
  const addDictionary = () => setDraft((current) => { const id = uid("dictionary"); return { ...current, dictionaries: [...current.dictionaries, { id, name: "New dictionary", entries: [] }] }; });
  const agent = agentDrafts[agentIndex];
  const agentFastModeEnabled = agent?.fastMode ?? draft.defaultFastMode;
  const updateAgent = (value: Partial<AgentProfile>) => setAgentDrafts((current) => current.map((item, index) => index === agentIndex ? { ...item, ...value } : item));
  const toggleAgentResource = (key: "tools" | "skills" | "mcpServers", value: string) => { if (agent) updateAgent({ [key]: agent[key].includes(value) ? agent[key].filter((item) => item !== value) : [...agent[key], value] }); };
  const renameAgent = (name: string) => { if (!agent || (!isBuiltInAgent(agent) && name.trim().toLowerCase() === "general")) return; if ((draft.defaultAgent ?? "general") === agent.name) patch({ defaultAgent: name }); updateAgent({ name }); };
  const addAgent = () => { let suffix = nextAgentSuffixRef.current; while (agentDrafts.some((item) => item.name.toLowerCase() === `agent-${suffix}`)) suffix += 1; nextAgentSuffixRef.current = suffix + 1; const next: AgentProfile = { name: `agent-${suffix}`, model: "", effort: "", path_systemprompt: "sysprompt/default.md", path_agentprompt: "", tools: draft.tools.filter((item) => item.enabled).map((item) => item.name), skills: draft.skills.filter((item) => item.enabled).map((item) => item.path), mcpServers: draft.mcpServers.filter((item) => item.enabled).map((item) => item.id) }; setAgentDrafts((current) => [...current, next]); setAgentIndex(agentDrafts.length); };
  const removeAgent = () => { if (!agent || isBuiltInAgent(agent)) return; if (draft.defaultAgent === agent.name) patch({ defaultAgent: "general" }); const next = agentDrafts.filter((_, index) => index !== agentIndex); setAgentDrafts(next); setAgentIndex(firstEditableAgent(next)); };
  const availableModelIds = new Set(models.map((model) => `${model.provider}/${model.id}`));
  const hiddenModels = new Set(draft.hiddenModels);
  const modelChoices = [...models.map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name || model.id }))];
  for (const id of hiddenModels) if (!availableModelIds.has(id)) modelChoices.push({ id, name: id });
  const filteredModelChoices = modelChoices.filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase().includes(modelFilter.trim().toLocaleLowerCase()));
  const modelDiscoveryUnavailable = models.length === 0;
  const thinkingDiscoveryUnavailable = thinkingLevels.length === 0;
  const availableMcpIds = new Set(draft.mcpServers.map((server) => server.id));
  const agentsValid = !agentConfig || (agentDrafts.some(isBuiltInAgent) && agentDrafts.every((item) => item.name.length > 0 && !!item.path_systemprompt?.trim() && (!item.model || modelDiscoveryUnavailable || availableModelIds.has(item.model)) && (!item.effort || thinkingDiscoveryUnavailable || thinkingLevels.includes(item.effort)) && item.mcpServers.every((id) => availableMcpIds.has(id))) && new Set(agentDrafts.map((item) => item.name)).size === agentDrafts.length);
  const defaultAgentAvailable = !agentConfig || agentDrafts.some((item) => item.name === (draft.defaultAgent ?? "general"));
  const invalidHost = draft.hosts.find((host) => !host.name.trim() || !host.target.trim() || !host.piPath.trim());
  const invalidMcp = draft.mcpServers.find((server) => mcpServerError(server));
  const activeDictionaryIds = new Set(draft.activeDictionaryIds);
  const dictionaryKeyCounts = new Map<string, number>();
  draft.dictionaries.filter((dictionary) => activeDictionaryIds.has(dictionary.id)).forEach((dictionary) => dictionary.entries.forEach((entry) => { const key = entry.word.trim(); if (key) dictionaryKeyCounts.set(key, (dictionaryKeyCounts.get(key) ?? 0) + 1); }));
  const duplicateDictionaryKeys = new Set([...dictionaryKeyCounts].filter(([, count]) => count > 1).map(([key]) => key));
  const invalidDictionary = draft.dictionaries.find((dictionary) => !dictionary.name.trim());
  const invalidActiveDictionaryEntry = draft.dictionaries.find((dictionary) => activeDictionaryIds.has(dictionary.id) && dictionary.entries.some((entry) => !entry.word.trim() || !entry.replacement.trim()));
  const shortcutList = Object.values(draft.keybindings).filter((shortcut) => shortcut.trim());
  const duplicateShortcuts = new Set<string>();
  for (let i = 0; i < shortcutList.length; i += 1) for (let j = i + 1; j < shortcutList.length; j += 1) {
    const left = shortcutList[i].trim().toLowerCase();
    const right = shortcutList[j].trim().toLowerCase();
    if (left === right || shortcutsConflict(shortcutList[i], shortcutList[j])) {
      duplicateShortcuts.add(left);
      duplicateShortcuts.add(right);
    }
  }
  const unsafeShortcut = Object.values(draft.keybindings).find((shortcut) => shortcut.trim() && !/[+]/.test(shortcut));
  const contextWindowValid = Number.isInteger(draft.contextWindowCap) && draft.contextWindowCap >= 1000 && draft.contextWindowCap <= 10000000 && Number.isSafeInteger(draft.contextWindowCap);
  const duplicateNames = <T extends { name: string }>(items: T[]) => { const counts = new Map<string, number>(); items.forEach((item) => { const name = item.name.trim().toLowerCase(); if (name) counts.set(name, (counts.get(name) ?? 0) + 1); }); return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name)); };
  const duplicateHostNames = duplicateNames(draft.hosts);
  const reservedLocalHostName = draft.hosts.some((host) => host.name.trim().toLowerCase() === "local");
  const duplicateMcpNames = duplicateNames(draft.mcpServers);
  const duplicateDictionaryNames = duplicateNames(draft.dictionaries);
  const duplicateAgentNames = duplicateNames(agentDrafts);
  const invalidAgentModel = modelDiscoveryUnavailable ? undefined : agentDrafts.find((item) => item.model && !availableModelIds.has(item.model));
  const invalidAgentEffort = thinkingDiscoveryUnavailable ? undefined : agentDrafts.find((item) => item.effort && !thinkingLevels.includes(item.effort));
  const danglingAgentMcp = agentDrafts.find((item) => item.mcpServers.some((id) => !availableMcpIds.has(id)));
  const danglingMcpId = danglingAgentMcp?.mcpServers.find((id) => !availableMcpIds.has(id));
  const emptyAgent = agentDrafts.find((item) => !item.name.trim());
  const missingAgentPrompt = agentDrafts.find((item) => !item.path_systemprompt?.trim());
  const validationError = !defaultAgentAvailable ? `Default agent is unavailable: ${draft.defaultAgent}` : !contextWindowValid ? "Context window cap must be a whole number of at least 1000" : draft.hosts.length > 16 ? "At most 16 remote machines can be configured" : reservedLocalHostName ? "The machine name “Local” is reserved for this machine" : duplicateHostNames.size ? `Machine name “${[...duplicateHostNames][0]}” is used more than once` : invalidHost ? `${invalidHost.name.trim() || "Machine"}: name, SSH target, and Pi executable are required` : draft.mcpServers.length > 32 ? "At most 32 MCP servers can be configured" : duplicateMcpNames.size ? `MCP server name “${[...duplicateMcpNames][0]}” is used more than once` : invalidMcp ? `${invalidMcp.name.trim() || "MCP server"}: ${mcpServerError(invalidMcp)}` : invalidDictionary ? "Dictionary name is required" : duplicateDictionaryNames.size ? `Dictionary name “${[...duplicateDictionaryNames][0]}” is used more than once` : invalidActiveDictionaryEntry ? `${invalidActiveDictionaryEntry.name}: enabled entries require both a word and replacement` : duplicateDictionaryKeys.size ? `Dictionary key “${[...duplicateDictionaryKeys][0]}” appears more than once in active dictionaries` : unsafeShortcut ? `Shortcut “${unsafeShortcut}” must include a modifier key` : duplicateShortcuts.size ? `Shortcut “${[...duplicateShortcuts][0]}” is assigned more than once` : !agentDrafts.some(isBuiltInAgent) && agentConfig ? "The built-in general agent is required" : emptyAgent ? "Agent name is required" : duplicateAgentNames.size ? `Agent name “${[...duplicateAgentNames][0]}” is used more than once` : invalidAgentModel ? `${invalidAgentModel.name}: model is unavailable: ${invalidAgentModel.model}` : invalidAgentEffort ? `${invalidAgentEffort.name}: effort is unavailable: ${invalidAgentEffort.effort}` : danglingAgentMcp ? `${danglingAgentMcp.name}: remove unavailable MCP server “${danglingMcpId}”` : missingAgentPrompt ? `${missingAgentPrompt.name}: system prompt file is required. Set it in Settings → Agents; for an older profile, restart Piop to migrate its prompt.` : !agentsValid ? "Every agent needs a unique name and valid resources" : undefined;
  const invalidFastModeAgent = agentDrafts.find((item) => item.fastMode === true && !(agentConfig?.fastModeModels ?? []).includes(item.model || draft.defaultModel));
  const fastModeValidationError = invalidFastModeAgent ? `${invalidFastModeAgent.name}: model ${invalidFastModeAgent.model || draft.defaultModel} does not support fast mode` : undefined;
  const formValid = agentsValid && !validationError && !fastModeValidationError;
  const searchTerms = settingsQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matchingSections = sections.filter((item) => (item.id !== "agents" || Boolean(agentConfig)) && searchTerms.every((term) => item.label.toLocaleLowerCase().includes(term)));
  const visibleSection = matchingSections.some((item) => item.id === section) ? section : matchingSections[0]?.id;

   return <main className={dirty ? "settings-shell has-unsaved" : "settings-shell"}><header className="settings-header"><div><p className="eyebrow">piop</p><h1>Settings</h1><p>Configure how piop works across your projects.</p></div><div className="settings-save">{dirty && !saving && <small role="status" className="unsaved-badge"><span aria-hidden="true" />Unsaved changes</small>}{pendingSettingsCount > 0 && !dirty && <small role="status">Saved · waiting for {pendingSettingsCount} session{pendingSettingsCount === 1 ? "" : "s"} to apply changes</small>}{(saveError || validationError || fastModeValidationError) && <small role="alert">{saveError || validationError || fastModeValidationError}</small>}<button className={dirty && !saving && formValid ? "primary-button needs-save" : "primary-button"} disabled={saving || !dirty || !formValid} onClick={() => void save()}>{saved && !dirty ? <Check size={15} /> : <Save size={15} />}{saved && !dirty ? "Saved" : saving ? "Saving…" : "Save changes"}</button></div></header>
    <div className="settings-layout"><nav className="settings-nav"><label className="search settings-search"><Search size={15} /><input autoFocus type="search" aria-label="Search settings" placeholder="Search settings" value={settingsQuery} onChange={(event) => setSettingsQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSettingsQuery(""); } }} /></label>{matchingSections.map((item) => <button key={item.id} className={visibleSection === item.id ? "active" : ""} aria-current={visibleSection === item.id ? "page" : undefined} onClick={() => setSection(item.id)}><item.icon size={16} /><span>{item.label}</span></button>)}</nav>
      <section className="settings-content">
        {!matchingSections.length && <div className="empty-small" role="status">No settings match your search.</div>}
        {visibleSection === "hooks" && <HooksSettings hosts={settings.hosts} />}
        {visibleSection === "environment" && <SettingsSection title="Worktree scripts" description="Assign setup and cleanup scripts to a project and machine. Setup runs in order after creation; cleanup runs in reverse order before deletion. A failure stops the operation and keeps the worktree." headerAction={<button className="secondary-button" onClick={() => patch({ worktreeSetupScripts: [...(draft.worktreeSetupScripts ?? []), { id: uid("setup"), name: "Worktree script", script: "", cleanupScript: "", enabled: true, projectPath: "", hostId: "local" }] })}><CirclePlus size={15} />Add script</button>}>
          <p>Source workspace: <code>PIOP_SOURCE_TREE_PATH</code><br />Worktree: <code>PIOP_WORKTREE_PATH</code><br />Branch: <code>PIOP_WORKTREE_BRANCH</code></p>
          {(draft.worktreeSetupScripts ?? []).map((script, index, scripts) => {
            const update = (value: Partial<typeof script>) => patch({ worktreeSetupScripts: scripts.map((item) => item.id === script.id ? { ...item, ...value } : item) });
            return <div className="setup-script" key={script.id}>
              <div className="section-actions"><strong>Script {index + 1}</strong><Toggle label={`Enable ${script.name}`} checked={script.enabled} onChange={(enabled) => update({ enabled })} /><button disabled={index === 0} onClick={() => { const reordered = [...scripts]; [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]]; patch({ worktreeSetupScripts: reordered }); }}>Move up</button><button onClick={() => patch({ worktreeSetupScripts: scripts.filter((item) => item.id !== script.id) })}>Remove</button></div>
              <label className="field"><span>Name</span><input aria-label={`Script ${index + 1} name`} value={script.name} onChange={(event) => update({ name: event.target.value })} /></label>
              <label className="field"><span>Machine</span><select aria-label={`Script ${index + 1} machine`} value={script.hostId ?? "local"} onChange={(event) => update({ hostId: event.target.value, projectPath: "" })}><option value="local">Local</option>{draft.hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}{script.hostId && script.hostId !== "local" && !draft.hosts.some((host) => host.id === script.hostId) && <option value={script.hostId}>Unavailable machine</option>}</select></label>
              <label className="field"><span>Project directory</span><input aria-label={`Script ${index + 1} project directory`} list={`setup-projects-${script.id}`} placeholder="Absolute path to the repository" value={script.projectPath ?? ""} onChange={(event) => update({ projectPath: event.target.value })} /></label>
              <datalist id={`setup-projects-${script.id}`}>{[...new Set(sessions.filter((session) => (session.hostId ?? "local") === (script.hostId ?? "local") && session.projectKind !== "no-repo").map((session) => session.projectRoot ?? session.cwd))].map((path) => <option key={path} value={path} />)}</datalist>
              {!script.projectPath?.trim() && <p className="empty-small">Choose a project directory to run this script. Unassigned scripts are kept but do not run.</p>}
              <label className="field"><span>Setup Bash script</span><textarea className="setup-script-code" aria-label={`Script ${index + 1} setup Bash code`} rows={8} spellCheck={false} placeholder={'npm ci\n# Or copy files from "$PIOP_SOURCE_TREE_PATH"'} value={script.script} onChange={(event) => update({ script: event.target.value })} /></label>
              <label className="field"><span>Cleanup Bash script</span><textarea className="setup-script-code" aria-label={`Script ${index + 1} cleanup Bash code`} rows={8} spellCheck={false} placeholder={'# Remove resources created for "$PIOP_WORKTREE_BRANCH"'} value={script.cleanupScript ?? ""} onChange={(event) => update({ cleanupScript: event.target.value })} /></label>
            </div>;
          })}
          {!draft.worktreeSetupScripts?.length && <div className="empty-small">Add scripts to prepare new worktrees and clean up their external resources before deletion.</div>}
        </SettingsSection>}
        {visibleSection === "general" && <SettingsSection title="General" description="Agent behavior.">
          <SettingRow icon={<CircleGauge />} title="Default context window cap" description="Applies to new conversations. Each conversation keeps its initial cap, including whether it is enabled."><div className="setting-cap-controls"><input className="setting-number" aria-label="Context window cap" aria-invalid={!contextWindowValid} disabled={!draft.contextWindowCapEnabled} type="number" min={1000} max={10000000} step={1000} value={draft.contextWindowCap} onChange={(event) => patch({ contextWindowCap: Number(event.target.value) })} /><Toggle label="Enable context window cap" checked={draft.contextWindowCapEnabled} onChange={(contextWindowCapEnabled) => patch({ contextWindowCapEnabled })} /></div></SettingRow>
          <SettingRow icon={<ShieldCheck />} title="Automatic retry" description="Retry transient provider and network errors."><Toggle label="Automatic retry" checked={draft.autoRetry} onChange={(autoRetry) => patch({ autoRetry })} /></SettingRow>
          <div className="general-agent-default">
          <label className="field"><span>Default agent</span><select aria-label="Default agent" disabled={!agentConfig} value={draft.defaultAgent ?? "general"} onChange={(event) => patch({ defaultAgent: event.target.value })}>{!defaultAgentAvailable && <option value={draft.defaultAgent} disabled>Unavailable: {draft.defaultAgent}</option>}{!agentConfig && <option value={draft.defaultAgent ?? "general"}>{draft.defaultAgent ?? "general"}</option>}{agentDrafts.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select><small>Used for new conversations. Configure model, effort, and fast mode in Agents.</small></label>
          </div>
        </SettingsSection>}
  {visibleSection === "models" && <SettingsSection title="Models" description="Choose which models appear in chat pickers. Existing conversations and default models are unchanged. Newly arrived models start hidden." headerAction={<div className="section-actions"><label className="section-filter"><Search size={14} /><input aria-label="Filter models" placeholder="Filter by name or provider" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} /></label><button className="section-toggle-all" disabled={hiddenModels.size === 0} onClick={() => patch({ hiddenModels: [] })}>Show all</button></div>}>
          <div className="config-list">{filteredModelChoices.map((model) => <div className="config-row model-row" key={model.id}><span className="config-icon"><Cpu size={16} /></span><span><strong>{model.name}</strong><small>{model.id}{!availableModelIds.has(model.id) ? " · Currently unavailable" : ""}</small></span><Toggle label={`Show ${model.id}`} checked={!hiddenModels.has(model.id)} onChange={(visible) => setDraft((current) => ({ ...current, hiddenModels: visible ? current.hiddenModels.filter((id) => id !== model.id) : [...current.hiddenModels, model.id] }))} /></div>)}</div>
          {!filteredModelChoices.length && <div className="empty-small">{modelChoices.length ? "No models match your search." : "No models discovered. Connect to a session to manage model visibility."}</div>}
        </SettingsSection>}
        {visibleSection === "dictionaries" && <SettingsSection title="Dictionaries" description="Highlight configured words while typing and replace them only when a prompt is submitted." headerAction={<button className="secondary-button" onClick={addDictionary}><CirclePlus size={15} />Add dictionary</button>}>
          <div className="dictionary-list">{draft.dictionaries.map((dictionary) => <div className="mcp-card dictionary-card" key={dictionary.id}>
            <div className="dictionary-card-head"><span className="config-icon dictionary"><BookOpen size={16} /></span><input aria-label="Dictionary name" aria-invalid={duplicateDictionaryNames.has(dictionary.name.trim().toLowerCase())} value={dictionary.name} onChange={(event) => setDraft((current) => ({ ...current, dictionaries: current.dictionaries.map((item) => item.id === dictionary.id ? { ...item, name: event.target.value } : item) }))} /><Toggle label={`${draft.activeDictionaryIds.includes(dictionary.id) ? "Disable" : "Enable"} ${dictionary.name}`} checked={draft.activeDictionaryIds.includes(dictionary.id)} onChange={(enabled) => patch({ activeDictionaryIds: enabled ? [...draft.activeDictionaryIds, dictionary.id] : draft.activeDictionaryIds.filter((id) => id !== dictionary.id) })} /><IconButton label={`Remove ${dictionary.name}`} onClick={() => setDraft((current) => ({ ...current, activeDictionaryIds: current.activeDictionaryIds.filter((id) => id !== dictionary.id), dictionaries: current.dictionaries.filter((item) => item.id !== dictionary.id) }))}><Trash2 size={15} /></IconButton></div>
            <div className="dictionary-entries">{dictionary.entries.map((entry, entryIndex) => <div className="dictionary-entry" key={entryIndex}><input aria-label={`Word ${entryIndex + 1}`} aria-invalid={activeDictionaryIds.has(dictionary.id) && duplicateDictionaryKeys.has(entry.word.trim())} placeholder="Word" value={entry.word} onChange={(event) => setDraft((current) => ({ ...current, dictionaries: current.dictionaries.map((item) => item.id === dictionary.id ? { ...item, entries: item.entries.map((candidate, index) => index === entryIndex ? { ...candidate, word: event.target.value } : candidate) } : item) }))} /><span>→</span><input aria-label={`Replacement ${entryIndex + 1}`} placeholder="Replacement" value={entry.replacement} onChange={(event) => setDraft((current) => ({ ...current, dictionaries: current.dictionaries.map((item) => item.id === dictionary.id ? { ...item, entries: item.entries.map((candidate, index) => index === entryIndex ? { ...candidate, replacement: event.target.value } : candidate) } : item) }))} /><IconButton label={`Remove entry ${entryIndex + 1}`} onClick={() => setDraft((current) => ({ ...current, dictionaries: current.dictionaries.map((item) => item.id === dictionary.id ? { ...item, entries: item.entries.filter((_, index) => index !== entryIndex) } : item) }))}><Trash2 size={14} /></IconButton></div>)}</div>
            <button className="secondary-button dictionary-add-entry" onClick={() => setDraft((current) => ({ ...current, dictionaries: current.dictionaries.map((item) => item.id === dictionary.id ? { ...item, entries: [...item.entries, { word: "", replacement: "" }] } : item) }))}><CirclePlus size={14} />Add word</button>
          </div>)}</div>
          {!draft.dictionaries.length && <div className="empty-small">Add a dictionary to get started.</div>}
        </SettingsSection>}
        {visibleSection === "agents" && <SettingsSection title="Agents" description="Choose defaults, instructions, and the resources each agent may see." headerAction={<button className="secondary-button" onClick={addAgent}><CirclePlus size={15} />Add agent</button>}>
          <div className="agent-editor"><div className="agent-list">{agentDrafts.map((item, index) => <button key={`${item.name}-${index}`} className={index === agentIndex ? "active" : ""} onClick={() => setAgentIndex(index)}><Bot size={14} /><span>{item.name}</span>{isBuiltInAgent(item) && <small>Built in</small>}</button>)}</div>
            {agent && <div className="agent-fields"><div className="agent-name-row"><label className="field"><span>Agent name</span><input aria-label="Agent name" aria-invalid={!isBuiltInAgent(agent) && (!agent.name.trim() || agent.name.trim().toLowerCase() === "general" || duplicateAgentNames.has(agent.name.trim().toLowerCase()))} disabled={isBuiltInAgent(agent)} value={agent.name} onChange={(event) => renameAgent(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))} /></label><IconButton label={`Remove ${agent.name}`} disabled={isBuiltInAgent(agent)} onClick={removeAgent}><Trash2 size={15} /></IconButton></div>
              <div className="agent-defaults"><label className="field"><span>Default model</span><select aria-label="Agent default model" value={agent.model} onChange={(event) => updateAgent({ model: event.target.value })}><option value="">Use fallback ({draft.defaultModel})</option>{agent.model && !availableModelIds.has(agent.model) && <option value={agent.model} disabled>Unavailable: {agent.model}</option>}{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name || model.id}</option>)}</select></label><div className="field general-fast-mode" title={agent.fastMode === undefined ? "Using the fallback fast mode setting" : "Fast mode default for this agent"}><span>Fast mode</span><div><button type="button" className={`fast-mode-indicator${agentFastModeEnabled ? " active" : ""}`} aria-label="Agent fast mode" aria-description={agent.fastMode === undefined ? "Using fallback setting" : agentFastModeEnabled ? "Fast mode on" : "Fast mode off"} aria-pressed={agentFastModeEnabled} aria-invalid={agent.fastMode === true && !(agentConfig?.fastModeModels ?? []).includes(agent.model || draft.defaultModel)} onClick={() => updateAgent({ fastMode: !agentFastModeEnabled })}><Zap size={22} strokeWidth={1.5} fill={agentFastModeEnabled ? "currentColor" : "none"} aria-hidden="true" /></button></div></div><label className="field"><span>Default effort</span><select aria-label="Agent default effort" aria-invalid={Boolean(!thinkingDiscoveryUnavailable && agent.effort && !thinkingLevels.includes(agent.effort))} value={agent.effort} onChange={(event) => updateAgent({ effort: event.target.value })}><option value="">Use fallback ({draft.defaultThinking})</option>{agent.effort && !thinkingLevels.includes(agent.effort) && <option value={agent.effort} disabled>Unavailable: {agent.effort}</option>}{thinkingLevels.map((level) => <option key={level} value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>)}</select></label></div>
              <label className="field"><span>System prompt file</span><input aria-label="System prompt file" aria-invalid={!agent.path_systemprompt?.trim()} placeholder="Path relative to agent config.json, or absolute path" value={agent.path_systemprompt ?? ""} onChange={(event) => updateAgent({ path_systemprompt: event.target.value })} /></label><label className="field"><span>Agent prompt file</span><input aria-label="Agent prompt file" placeholder="Optional path to an agent prompt file" value={agent.path_agentprompt ?? ""} onChange={(event) => updateAgent({ path_agentprompt: event.target.value })} /></label>
              <label className="field"><span>piop extensions (one path per line)</span><textarea aria-label="Agent piop extensions" placeholder="/path/to/extension.ts" value={(agent.extensions ?? []).join("\n")} onChange={(event) => updateAgent({ extensions: event.target.value.split("\n") })} onBlur={() => updateAgent({ extensions: (agent.extensions ?? []).map(path => path.trim()).filter(Boolean) })} /></label>
              <AgentAllowlist title="Tools">{draft.tools.map((tool) => <label key={tool.name}><input type="checkbox" aria-label={`Allow ${tool.name}`} checked={agent.tools.includes(tool.name)} onChange={() => toggleAgentResource("tools", tool.name)} />{tool.name}</label>)}</AgentAllowlist><AgentAllowlist title="Skills">{draft.skills.map((skill) => <label key={skill.path}><input type="checkbox" aria-label={`Allow ${skill.name}`} checked={agent.skills.includes(skill.path)} onChange={() => toggleAgentResource("skills", skill.path)} />{skill.name}</label>)}</AgentAllowlist><AgentAllowlist title="MCP servers">{draft.mcpServers.map((server) => <label key={server.id}><input type="checkbox" aria-label={`Allow ${server.name}`} checked={agent.mcpServers.includes(server.id)} onChange={() => toggleAgentResource("mcpServers", server.id)} />{server.name}</label>)}{agent.mcpServers.filter((id) => !availableMcpIds.has(id)).map((id) => <label className="agent-resource-unavailable" key={`unavailable:${id}`}><input type="checkbox" aria-label={`Remove unavailable MCP server ${id}`} checked onChange={() => toggleAgentResource("mcpServers", id)} /><span>Unavailable: <code>{id}</code></span></label>)}</AgentAllowlist>
            </div>}
          </div>
        </SettingsSection>}
        {visibleSection === "storage" && <StorageSettings />}
        {visibleSection === "machines" && <SettingsSection title="Machines" description="Run projects through Pi installations reachable with SSH."><div className="mcp-list"><div className="mcp-card"><div className="mcp-card-head"><span className="config-icon mcp"><Server size={16} /></span><strong>Local</strong><code>This machine</code></div></div>{draft.hosts.map((host) => <div className="mcp-card" key={host.id}><div className="mcp-card-head"><span className="config-icon mcp"><Server size={16} /></span><input aria-label="Machine name" aria-invalid={!host.name.trim() || host.name.trim().toLowerCase() === "local" || duplicateHostNames.has(host.name.trim().toLowerCase())} value={host.name} onChange={(event) => updateHost(host.id, { name: event.target.value })} /><IconButton label={`Remove ${host.name}`} onClick={() => removeHost(host)}><Trash2 size={15} /></IconButton></div><div className="command-fields"><label><span>SSH target</span><input aria-label={`${host.name} SSH target`} aria-invalid={!host.target.trim()} placeholder="user@example.com" value={host.target} onChange={(event) => updateHost(host.id, { target: event.target.value })} /></label><label><span>Pi executable</span><input aria-label={`${host.name} Pi executable`} aria-invalid={!host.piPath.trim()} placeholder="pi" value={host.piPath} onChange={(event) => updateHost(host.id, { piPath: event.target.value })} /></label></div></div>)}</div><button className="secondary-button" disabled={draft.hosts.length >= 16} onClick={addHost}><CirclePlus size={15} />Add machine</button></SettingsSection>}
        {visibleSection === "keybinds" && <SettingsSection title="Keybinds" description="Customize global application shortcuts."><div className="keybind-list">{keybindDefinitions.map((binding) => <label className="keybind-row" key={binding.action}><span><strong>{binding.label}</strong><small>{binding.description}</small></span><KeybindInput action={binding.action} value={draft.keybindings[binding.action]} invalid={duplicateShortcuts.has(draft.keybindings[binding.action].trim().toLowerCase())} onChange={(shortcut) => setDraft((current) => ({ ...current, keybindings: { ...current.keybindings, [binding.action]: shortcut } }))} /></label>)}</div><button className="secondary-button" onClick={() => patch({ keybindings: { ...defaultKeybindings } })}><RotateCcw size={15} />Restore defaults</button></SettingsSection>}
        {visibleSection === "tools" && <SettingsSection title="Tools" description="Available tools. Choose which tools each agent may use in Agents."><div className="config-list">{draft.tools.map((tool) => <div className="config-row" key={tool.name}><span className="config-icon"><Wrench size={16} /></span><span><strong>{tool.name}</strong><small>{tool.description}</small></span><code>{tool.builtin ? "built-in" : "desktop"}</code></div>)}</div></SettingsSection>}
        {visibleSection === "skills" && <SettingsSection title="Skills" description="Reusable instructions. Choose which skills each agent may use in Agents." headerAction={<div className="section-actions"><label className="section-filter"><Search size={14} /><input aria-label="Filter skills by name" placeholder="Filter by name" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)} /></label></div>}><div className="config-list">{draft.skills.map((skill, index) => ({ skill, index })).filter(({ skill }) => skill.name.toLocaleLowerCase().includes(skillFilter.trim().toLocaleLowerCase())).map(({ skill, index }) => <div className="config-row skill-row" key={`${skill.path}-${index}`}><span className="config-icon skill"><Sparkles size={16} /></span><span><strong>{skill.name}</strong><small>{skill.description}</small></span>{skill.userInvokedOnly && <span className="skill-invocation" title="This skill can only be invoked explicitly">User invoked only</span>}</div>)}</div></SettingsSection>}
        {visibleSection === "mcp" && <SettingsSection title="MCP servers" description="Connect external tools and data sources through Model Context Protocol."><div className="mcp-list">{draft.mcpServers.map((server) => { const fieldError = mcpServerError(server); return <div className="mcp-card" key={server.id}><div className="mcp-card-head"><span className="config-icon mcp"><PlugZap size={16} /></span><input aria-label="Server name" aria-invalid={!server.name.trim() || duplicateMcpNames.has(server.name.trim().toLowerCase())} value={server.name} onChange={(e) => updateMcp(server.id, { name: e.target.value })} /><IconButton label={`Remove ${server.name}`} onClick={() => removeMcp(server.id)}><Trash2 size={15} /></IconButton></div>{fieldError && <small className="mcp-error" role="alert">{fieldError}</small>}<div className="field"><span>Transport</span><div className="mcp-transport-toggle" role="group" aria-label={`${server.name} transport`}>{(["stdio", "http"] as const).map((transport) => <button key={transport} type="button" aria-pressed={(server.transport ?? "stdio") === transport} onClick={() => updateMcp(server.id, { transport })}>{transport === "stdio" ? "stdio" : "HTTP"}</button>)}</div></div><label className="field"><span>Startup timeout (seconds)</span><input type="number" min={1} max={600} step={1} aria-label={`${server.name} startup timeout`} value={mcpTimeoutInputs[server.id] ?? server.startupTimeoutSec ?? 10} onChange={(event) => { const value = event.target.value; setMcpTimeoutInputs((current) => ({ ...current, [server.id]: value })); updateMcp(server.id, { startupTimeoutSec: Number(value) }); }} /></label>{(server.transport ?? "stdio") === "stdio" ? <div className="command-fields stdio-fields"><label><span>Command</span><input aria-invalid={!server.command.trim()} value={server.command} onChange={(e) => updateMcp(server.id, { command: e.target.value })} /></label><label><span>Arguments</span><input value={server.args} onChange={(e) => updateMcp(server.id, { args: e.target.value })} /></label></div> : <div className="command-fields http-fields"><label><span>URL</span><input type="url" aria-invalid={Boolean(fieldError?.includes("URL"))} placeholder="https://example.com/mcp" value={server.url ?? ""} onChange={(e) => updateMcp(server.id, { url: e.target.value })} /></label><label><span>Headers (JSON)</span><input aria-invalid={Boolean(fieldError?.startsWith("Headers"))} placeholder={'{"Authorization":"Bearer …"}'} value={server.headers ?? ""} onChange={(e) => updateMcp(server.id, { headers: e.target.value })} /></label></div>}</div>; })}</div><button className="secondary-button" disabled={draft.mcpServers.length >= 32} onClick={addMcp}><CirclePlus size={15} />Add MCP server</button></SettingsSection>}
      </section></div>
    {dirty && pastHeader && <div className="settings-save-fab"><button className={dirty && !saving && formValid ? "primary-button needs-save" : "primary-button"} disabled={saving || !dirty || !formValid} onClick={() => void save()}><Save size={15} />{saving ? "Saving…" : "Save changes"}</button></div>}
  </main>;
}

function SettingsSection({ title, description, headerAction, children }: { title: string; description: string; headerAction?: React.ReactNode; children: React.ReactNode }) { return <div className="settings-section"><div className="section-title"><div><h2>{title}</h2><p>{description}</p></div>{headerAction}</div>{children}</div>; }
function AgentAllowlist({ title, children }: { title: string; children: React.ReactNode }) { return <fieldset className="agent-allowlist"><legend>{title}</legend><div>{children}</div></fieldset>; }
function SettingRow({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) { return <div className="setting-row"><span className="setting-icon">{icon}</span><span><strong>{title}</strong><small>{description}</small></span><div>{children}</div></div>; }
function KeybindInput({ action, value, invalid, onChange }: { action: KeybindAction; value: string; invalid?: boolean; onChange: (shortcut: string) => void }) { return <input className="keybind-input" aria-label={`${keybindDefinitions.find((item) => item.action === action)?.label} shortcut`} aria-invalid={invalid} value={value} placeholder="Unassigned" readOnly onKeyDown={(event) => { if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) return; event.preventDefault(); event.stopPropagation(); if (event.key === "Backspace" || event.key === "Delete") { onChange(""); return; } const shortcut = shortcutFromEvent(event.nativeEvent); if (shortcut) onChange(shortcut); }} />; }
