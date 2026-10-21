import { createMemo, For, Show, type JSXElement } from "solid-js";
import type { AgentProfile, SkillConfig, ToolConfig } from "../types";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./agent-tools.css";

const toolGroups = [
  { name: "Goal", tools: ["get_goal", "create_goal", "update_goal"] },
  { name: "Subagents", tools: ["subagent", "wait_agent"] },
  { name: "Orchestration", tools: ["list_agents", "send_message"] },
];

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
  const groupItems = (names: string[]) => props.tools.filter(tool => names.includes(tool.name)).map(item);

  return <>
    <For each={props.tools.filter(tool => !toolGroups.some(group => group.tools.includes(tool.name)) && matches(tool.name, props.query))}>{tool => <ItemCheckbox item={item(tool)} selected={props.selected} onToggle={toggle} />}</For>
    <For each={toolGroups.filter(group => visible(group.name, groupItems(group.tools), props.query).length)}>{group =>
      <AllowGroup name={group.name} kind="tools" items={visible(group.name, groupItems(group.tools), props.query)} selected={props.selected} onToggle={toggle}>
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
