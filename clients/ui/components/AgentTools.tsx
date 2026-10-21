import { For, Show } from "solid-js";
import type { AgentProfile, ToolConfig } from "../types";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./agent-tools.css";

const toolGroups = [
  { name: "Goal", tools: ["get_goal", "create_goal", "update_goal"] },
  { name: "Subagents", tools: ["subagent", "wait_agent"] },
];

export function AgentTools(props: { tools: ToolConfig[]; selected: string[]; onChange: (tools: string[]) => void; agent: AgentProfile; onLimitsChange: (limits: Partial<AgentProfile>) => void }) {
  const toggle = (names: string[], enabled: boolean) => props.onChange(enabled
    ? [...new Set([...props.selected, ...names])]
    : props.selected.filter(name => !names.includes(name)));

  const renderTool = (tool: ToolConfig) => <label><input type="checkbox" aria-label={`Allow ${tool.name}`} checked={props.selected.includes(tool.name)} onInput={event => toggle([tool.name], event.currentTarget.checked)} />{tool.name}</label>;

  return <>
    <For each={props.tools.filter(tool => !toolGroups.some(group => group.tools.includes(tool.name)))}>{renderTool}</For>
    <For each={toolGroups.filter(group => props.tools.some(tool => group.tools.includes(tool.name)))}>{group => {
      const members = () => props.tools.filter(tool => group.tools.includes(tool.name));
      const all = () => members().every(tool => props.selected.includes(tool.name));
      const some = () => members().some(tool => props.selected.includes(tool.name));
      const checkbox = createRef<HTMLInputElement>(null);
      createDependencyEffect(() => { if (checkbox.current) checkbox.current.indeterminate = some() && !all(); }, () => [some(), all()]);

      return <section class="agent-tool-group" aria-label={`${group.name} tools`}>
        <h4 class="agent-tool-group-heading"><label>{group.name}<input ref={element => { checkbox.current = element; }} type="checkbox" aria-label={`Allow all ${group.name} tools`} checked={all()} onInput={event => toggle(members().map(tool => tool.name), event.currentTarget.checked)} /></label></h4>
        <div class="agent-tool-group-members"><For each={members()}>{renderTool}</For></div>
      </section>;
    }}</For>
    <Show when={props.selected.includes("subagent")}>
      <div class="agent-subagent-limits">
        <label class="field"><span>Max subagents</span><input type="number" aria-label="Max subagents" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={props.agent.max_subagents ?? 8} onInput={event => props.onLimitsChange({ max_subagents: event.currentTarget.valueAsNumber })} /></label>
        <label class="field"><span>Max 2nd level subagents</span><input type="number" aria-label="Max 2nd level subagents" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={props.agent.max_sub_subagents ?? 8} onInput={event => props.onLimitsChange({ max_sub_subagents: event.currentTarget.valueAsNumber })} /></label>
      </div>
    </Show>
  </>;
}
