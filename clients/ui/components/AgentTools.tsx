import { createMemo, For, Show, type JSXElement } from "solid-js";
import type { AgentProfile, SkillConfig, ToolConfig } from "../types";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./agent-tools.css";

/** Groups for related tools, by tool name. Other tools are grouped by the extension that registered them. */
const toolGroups = [
  { name: "Goal", tools: ["get_goal", "create_goal", "update_goal"] },
  { name: "Subagents", tools: ["subagent", "spawn_agent", "followup_task", "interrupt_agent", "list_agents", "list_agent_profiles", "wait_agent", "await_subagents"] },
  { name: "Orchestration", tools: ["send_message", "send_message_to_thread", "receive_agent_message", "create_thread", "list_threads", "read_thread", "wait_threads", "stop_thread"] },
];

/** Tools that have their own setting. codemode follows the agent's Codemode switch. */
const HIDDEN_TOOLS = new Set(["codemode"]);

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

export function AgentTools(props: { tools: ToolConfig[]; query: string; selected: string[]; onChange: (tools: string[]) => void; agent: AgentProfile; onLimitsChange: (limits: Partial<AgentProfile>) => void }) {
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
        <Show when={group.name === "Subagents" && props.selected.includes("subagent")}>
          <div class="agent-subagent-limits">
            <label class="field"><span>Max subagents</span><input type="number" aria-label="Max subagents" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={props.agent.max_subagents ?? 8} onInput={event => props.onLimitsChange({ max_subagents: event.currentTarget.valueAsNumber })} /></label>
            <label class="field"><span>Max 2nd level subagents</span><input type="number" aria-label="Max 2nd level subagents" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={props.agent.max_sub_subagents ?? 8} onInput={event => props.onLimitsChange({ max_sub_subagents: event.currentTarget.valueAsNumber })} /></label>
          </div>
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
