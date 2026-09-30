import { For } from "solid-js";
import type { ToolConfig } from "../types";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./agent-tools.css";

const toolGroups = [{ name: "goal", tools: ["get_goal", "create_goal", "update_goal"] }];

export function AgentTools(props: { tools: ToolConfig[]; selected: string[]; onChange: (tools: string[]) => void }) {
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
  </>;
}
