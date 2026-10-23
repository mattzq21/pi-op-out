import { createMemo, For, Show, type JSXElement } from "solid-js";
import type { AgentAccess, AgentProfile, SkillConfig, ToolConfig } from "../types";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./agent-tools.css";

/** Groups for related tools, by tool name. Other tools are grouped by the extension that registered them. */
const toolGroups = [
  { name: "Goal", tools: ["update_goal_status"] },
  { name: "Subagents", tools: ["spawn_subagents", "message_subagent", "stop_subagent", "list_subagents", "await_subagents"] },
  { name: "Orchestration", tools: ["create_peer", "branchoff_peer", "message_peer", "stop_peer", "list_peers", "read_peer", "await_peers"] },
];

/** Tools that have their own setting. codemode follows the agent's Codemode switch; list_agent_profiles is on when the Subagents or Orchestration group is. */
const HIDDEN_TOOLS = new Set(["codemode", "list_agent_profiles"]);

/** The name of the extension that registered a tool, from its source path, or undefined for a Pi built-in. */
function sourceName(source: string): string | undefined {
  if (source.startsWith("builtin:")) return undefined;
  const parts = source.split("/").filter(Boolean);
  const file = (parts.at(-1) ?? source).replace(/\.[cm]?[jt]s$/, "");
  return file === "index" && parts.length > 1 ? parts.at(-2) : file;
}

/** Tools from extensions that are shown with the Pi built-in tools, outside any group. */
const UNGROUPED_TOOLS = new Set(["web_search"]);

/** The group a tool belongs to, or undefined for a tool shown without a group. */
const toolGroup = (tool: ToolConfig) => UNGROUPED_TOOLS.has(tool.name) ? undefined : toolGroups.find(group => group.tools.includes(tool.name))?.name ?? sourceName(tool.source);

const SKILLS_ROOT = "/.agents/skills/";

type Item = { key: string; label: string };

/** Whether the text contains the search query, ignoring case. An empty query matches everything. */
const matches = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());

/** The items to show: all of them when the group name matches, otherwise the items whose label matches. */
const visible = (name: string, items: Item[], query: string) => matches(name, query) ? items : items.filter(item => matches(item.label, query));

/** Adds or removes keys from the selection. */
const toggled = (selected: string[], keys: string[], enabled: boolean) => enabled
  ? [...new Set([...selected, ...keys])]
  : selected.filter(key => !keys.includes(key));

function ItemCheckbox(props: { item: Item; selected: string[]; onToggle: (keys: string[], enabled: boolean) => void }) {
  return <label><input type="checkbox" aria-label={`Allow ${props.item.label}`} checked={props.selected.includes(props.item.key)} onInput={event => props.onToggle([props.item.key], event.currentTarget.checked)} />{props.item.label}</label>;
}

/** A titled group of checkboxes with one checkbox that selects all of them. */
function AllowGroup(props: { name: string; kind: string; items: Item[]; selected: string[]; onToggle: (keys: string[], enabled: boolean) => void; children?: JSXElement }) {
  const all = () => props.items.every(item => props.selected.includes(item.key));
  const some = () => props.items.some(item => props.selected.includes(item.key));
  const checkbox = createRef<HTMLInputElement>(null);
  createDependencyEffect(() => { if (checkbox.current) checkbox.current.indeterminate = some() && !all(); }, () => [some(), all()]);

  return <section class="agent-tool-group" aria-label={`${props.name} ${props.kind}`}>
    <h4 class="agent-tool-group-heading"><label>{props.name}<input ref={element => { checkbox.current = element; }} type="checkbox" aria-label={`Allow all ${props.name} ${props.kind}`} checked={all()} onInput={event => props.onToggle(props.items.map(item => item.key), event.currentTarget.checked)} /></label></h4>
    <div class="agent-tool-group-members"><For each={props.items}>{item => <ItemCheckbox item={item} selected={props.selected} onToggle={props.onToggle} />}</For></div>
    {props.children}
  </section>;
}

const ACCESS_MODES = [{ mode: "all", label: "All" }, { mode: "none", label: "None" }, { mode: "list", label: "Only these" }] as const;

/** Chooses which agents this agent may start: all, none, or the checked ones. */
function AgentAccessPicker(props: { label: string; value: AgentAccess | undefined; names: string[]; onChange: (value: AgentAccess) => void }) {
  const list = () => Array.isArray(props.value) ? props.value : undefined;

  return <div class="agent-access">
    <div class="agent-access-row"><span>Callable agents</span><div class="segmented-control" role="group" aria-label={props.label}><For each={ACCESS_MODES}>{option => <button type="button" aria-pressed={(list() ? "list" : props.value ?? "all") === option.mode} onClick={() => props.onChange(option.mode === "list" ? list() ?? [] : option.mode)}>{option.label}</button>}</For></div></div>
    <Show when={list()}>{selected => <div class="agent-tool-group-members"><For each={props.names}>{name => <ItemCheckbox item={{ key: name, label: name }} selected={selected()} onToggle={(keys, enabled) => props.onChange(toggled(selected(), keys, enabled))} />}</For></div>}</Show>
  </div>;
}

export function AgentTools(props: { tools: ToolConfig[]; query: string; selected: string[]; onChange: (tools: string[]) => void; agent: AgentProfile; agentNames: string[]; onLimitsChange: (limits: Partial<AgentProfile>) => void }) {
  const toggle = (names: string[], enabled: boolean) => props.onChange(toggled(props.selected, names, enabled));
  const item = (tool: ToolConfig): Item => ({ key: tool.name, label: tool.name });
  const shown = createMemo(() => props.tools.filter(tool => !HIDDEN_TOOLS.has(tool.name)));
  const groups = createMemo(() => {
    const byGroup = new Map<string, Item[]>();
    for (const tool of shown()) {
      const group = toolGroup(tool);
      if (group !== undefined) byGroup.set(group, [...(byGroup.get(group) ?? []), item(tool)]);
    }
    const order = (name: string) => { const index = toolGroups.findIndex(group => group.name === name); return index < 0 ? toolGroups.length : index; };
    return [...byGroup].sort(([left], [right]) => order(left) - order(right) || left.localeCompare(right))
      .map(([name, items]) => ({ name, items: visible(name, items, props.query) })).filter(group => group.items.length);
  });

  return <>
    <For each={shown().filter(tool => toolGroup(tool) === undefined && matches(tool.name, props.query))}>{tool => <ItemCheckbox item={item(tool)} selected={props.selected} onToggle={toggle} />}</For>
    <For each={groups()}>{group =>
      <AllowGroup name={group.name} kind="tools" items={group.items} selected={props.selected} onToggle={toggle}>
        <Show when={group.name === "Subagents" && props.selected.includes("spawn_subagents")}>
          <div class="agent-subagent-limits">
            <label class="field"><span>Max subagents</span><input type="number" aria-label="Max subagents" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={props.agent.max_subagents ?? 8} onInput={event => props.onLimitsChange({ max_subagents: event.currentTarget.valueAsNumber })} /></label>
            <label class="field"><span>Max 2nd level subagents</span><input type="number" aria-label="Max 2nd level subagents" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={props.agent.max_sub_subagents ?? 8} onInput={event => props.onLimitsChange({ max_sub_subagents: event.currentTarget.valueAsNumber })} /></label>
          </div>
          <AgentAccessPicker label="Callable subagents" value={props.agent.allowed_subagents} names={props.agentNames} onChange={allowed_subagents => props.onLimitsChange({ allowed_subagents })} />
        </Show>
        <Show when={group.name === "Orchestration" && props.selected.includes("create_peer")}>
          <AgentAccessPicker label="Callable peers" value={props.agent.allowed_peers} names={props.agentNames} onChange={allowed_peers => props.onLimitsChange({ allowed_peers })} />
        </Show>
      </AllowGroup>}</For>
  </>;
}

/** The folder directly under ~/.agents/skills that holds the skill, or undefined for skills at the top of it. */
function skillFolder(path: string): string | undefined {
  const start = path.indexOf(SKILLS_ROOT);
  if (start < 0) return undefined;
  const parts = path.slice(start + SKILLS_ROOT.length).split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
}

export function AgentSkills(props: { skills: SkillConfig[]; query: string; selected: string[]; onChange: (skills: string[]) => void }) {
  const toggle = (paths: string[], enabled: boolean) => props.onChange(toggled(props.selected, paths, enabled));
  const item = (skill: SkillConfig): Item => ({ key: skill.path, label: skill.name });
  const groups = createMemo(() => {
    const byFolder = new Map<string, Item[]>();
    for (const skill of props.skills) {
      const folder = skillFolder(skill.path);
      if (folder !== undefined) byFolder.set(folder, [...(byFolder.get(folder) ?? []), item(skill)]);
    }
    return [...byFolder].sort(([left], [right]) => left.localeCompare(right)).map(([name, items]) => ({ name, items: visible(name, items, props.query) })).filter(group => group.items.length);
  });

  return <>
    <For each={props.skills.filter(skill => skillFolder(skill.path) === undefined && matches(skill.name, props.query)).map(item)}>{skill => <ItemCheckbox item={skill} selected={props.selected} onToggle={toggle} />}</For>
    <For each={groups()}>{group => <AllowGroup name={group.name} kind="skills" items={group.items} selected={props.selected} onToggle={toggle} />}</For>
  </>;
}
