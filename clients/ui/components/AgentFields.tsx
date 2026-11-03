import { Key } from "@solid-primitives/keyed";
import { createSignal, type JSXElement } from "solid-js";
import { Search, Zap } from "lucide-solid";
import type { AgentProfile, AppSettings, Model } from "../types";
import { AgentSkills, AgentTools } from "./AgentTools";
import { AgentExtensions } from "./AgentExtensions";
import { McpSettings, type McpEditorDraft } from "./McpSettings";
import { RefreshSkills, RefreshTools } from "./RefreshResources";
import { CapInput } from "./CapInput";
import { FilterSelect } from "./FilterSelect";
import { Toggle } from "./Toggle";

type CodemodeChoice = NonNullable<AgentProfile["codemode"]>;
const NEXT_CODEMODE: Record<CodemodeChoice, CodemodeChoice> = { on: "off", off: "on" };
const CODEMODE_HINTS: Record<CodemodeChoice, string> = {
  on: "ON: the agent calls tools directly or from codemode scripts.",
  off: "OFF: the agent calls every tool directly, without codemode.",
};

export function agentEffortLevels(models: Model[], agent: AgentProfile) {
  const model = models.find(item => `${item.provider}/${item.id}` === agent.model);
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  if (!model) return levels;

  if (!model.reasoning) return ["off"];

  return levels.filter(level => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
}

export interface AgentFieldsProps {
  agent: AgentProfile;
  update: (value: Partial<AgentProfile>) => void;
  disabled?: boolean;
  header: JSXElement;
  prompts: JSXElement;
  hostId: string;
  models: Model[];
  modelAliases: Record<string, string>;
  hiddenModels: ReadonlySet<string>;
  defaultThinking: string;
  defaultFastMode: boolean;
  supportsFastMode: (model: string) => boolean;
  tools: AppSettings["tools"];
  skills: AppSettings["skills"];
  onCatalog: (catalog: Partial<Pick<AppSettings, "tools" | "skills">>) => void;
  agentNames: string[];
  mcpDraft?: McpEditorDraft;
  onMcpDraft: (draft: McpEditorDraft) => void;
  onCapError: (error: string | undefined) => void;
}

export function AgentFields(props: AgentFieldsProps) {
  const [toolQuery, setToolQuery] = createSignal("");
  const [skillQuery, setSkillQuery] = createSignal("");
  const availableModelIds = () => new Set(props.models.map(model => `${model.provider}/${model.id}`));
  const levels = () => agentEffortLevels(props.models, props.agent);
  const fastModeEnabled = () => props.agent.fastMode ?? props.defaultFastMode;
  const codemode = () => props.agent.codemode ?? "on";

  const modelOptions = () => {
    const unavailableAlias = Object.hasOwn(props.modelAliases, props.agent.model) ? props.modelAliases[props.agent.model] : undefined;

    return [
      { value: "", label: "Use session model", search: "" },
      ...(props.agent.model && !availableModelIds().has(props.agent.model) ? [{ value: props.agent.model, label: `Unavailable: ${unavailableAlias || props.agent.model}`, search: `${unavailableAlias ?? ""} ${props.agent.model}`, disabled: true }] : []),
      ...props.models
        .map(model => { const id = `${model.provider}/${model.id}`; return { value: id, label: props.modelAliases[id] || model.name || model.id, search: `${props.modelAliases[id] ?? ""} ${model.name ?? ""} ${id}`, group: props.hiddenModels.has(id) ? 1 : 0 }; })
        .sort((left, right) => left.group - right.group),
    ];
  };

  const renderDefaults = () => (<div class="agent-defaults">
    <div class="field"><span>Default model</span><FilterSelect label="Agent default model" filterPlaceholder="Filter by alias, name or ID" value={props.agent.model} options={modelOptions()} onChange={model => props.update({ model })} /></div>
    <div class="field general-fast-mode" data-tooltip={props.agent.fastMode === undefined ? "Using the fallback fast mode setting" : "Fast mode default for this agent"}><span>Fast mode</span><div><button type="button" class={`fast-mode-indicator${fastModeEnabled() ? " active" : ""}`} aria-label="Agent fast mode" aria-description={props.agent.fastMode === undefined ? "Using fallback setting" : fastModeEnabled() ? "Fast mode on" : "Fast mode off"} aria-pressed={fastModeEnabled()} aria-invalid={props.agent.fastMode === true && !props.supportsFastMode(props.agent.model)} onClick={() => props.update({ fastMode: !fastModeEnabled() })}><Zap size={22} strokeWidth={1.5} fill={fastModeEnabled() ? "currentColor" : "none"} aria-hidden="true" /></button></div></div>
    <label class="field"><span>Default effort</span><select aria-label="Agent default effort" aria-invalid={Boolean(props.models.length && props.agent.effort && !levels().includes(props.agent.effort))} value={props.agent.effort} onChange={event => props.update({ effort: event.target.value })}><option value="">Use fallback ({props.defaultThinking})</option>{props.agent.effort && !levels().includes(props.agent.effort) && <option value={props.agent.effort} disabled>Unavailable: {props.agent.effort}</option>}<Key each={levels()} by={level => level}>{level => <option value={level()}>{level().charAt(0).toUpperCase() + level().slice(1)}</option>}</Key></select></label>
    <label class="field"><span>Context cap</span><CapInput label="Agent context cap" placeholder="Inherit" value={props.agent.contextWindowCap} onChange={contextWindowCap => props.update({ contextWindowCap })} onError={props.onCapError} /></label>
  </div>);

  const renderTools = () => (<div class="agent-fields-tools"><AgentAllowlist title="Tools" query={toolQuery()} onQuery={setToolQuery} titleAction={<><RefreshTools hostId={props.hostId} onChange={tools => props.onCatalog({ tools })} /><button type="button" class="agent-codemode" data-mode={codemode()} aria-label={"Codemode " + codemode().toUpperCase()} data-tooltip={CODEMODE_HINTS[codemode()]} onClick={() => props.update({ codemode: NEXT_CODEMODE[codemode()] })}>Codemode {codemode().toUpperCase()}</button></>}><AgentTools tools={props.tools} query={toolQuery()} selected={props.agent.tools} agent={props.agent} agentNames={props.agentNames} onChange={tools => props.update({ tools })} onLimitsChange={props.update} /></AgentAllowlist></div>);

  const renderSkills = () => (<div class="agent-fields-more"><AgentAllowlist title="Skills" query={skillQuery()} onQuery={setSkillQuery} titleAction={<RefreshSkills hostId={props.hostId} skills={props.skills} onChange={skills => props.onCatalog({ skills })} />}><AgentSkills skills={props.skills} query={skillQuery()} selected={props.agent.skills} onChange={skills => props.update({ skills })} /></AgentAllowlist></div>);

  return (<fieldset class="agent-fields" disabled={props.disabled}><div class="agent-fields-body"><div class="agent-fields-main">{props.header}
    <label class="field"><span>Description</span><textarea class="agent-description" aria-label="Agent description" maxLength={500} rows={2} placeholder="What this agent is for. Other agents see it when they choose an agent to start." value={props.agent.description ?? ""} onInput={event => props.update({ description: event.currentTarget.value || undefined })} /></label>
    {renderDefaults()}
    <div class="agent-usage"><div class="agent-usage-option"><span>Spawnable as subagent</span><Toggle label="Spawnable as subagent" checked={props.agent.allow_as_subagent !== false} onChange={allow_as_subagent => props.update({ allow_as_subagent })} /></div><div class="agent-usage-option"><span>Spawnable as peer</span><Toggle label="Spawnable as peer" checked={props.agent.allow_as_peer !== false} onChange={allow_as_peer => props.update({ allow_as_peer })} /></div></div>
    {props.prompts}
    <AgentExtensions paths={props.agent.extensions ?? []} onChange={extensions => props.update({ extensions })} /><McpSettings value={props.agent.mcpServers} draft={props.mcpDraft} onDraft={props.onMcpDraft} onChange={mcpServers => props.update({ mcpServers })} /></div>
    {renderTools()}{renderSkills()}</div>
  </fieldset>);
}

function AgentAllowlist(componentProps: { title: string; titleAction?: JSXElement; query: string; onQuery: (query: string) => void; children: JSXElement }) {
  return <fieldset class="agent-allowlist"><legend><span>{componentProps.title}</span>{componentProps.titleAction}<span class="agent-allowlist-line" /><label class="agent-allowlist-search"><Search size={14} aria-hidden="true" /><input type="search" placeholder="Search" aria-label={`Search ${componentProps.title.toLowerCase()}`} value={componentProps.query} onInput={event => componentProps.onQuery(event.currentTarget.value)} /></label></legend><div>{componentProps.children}</div></fieldset>;
}
