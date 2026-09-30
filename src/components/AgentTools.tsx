import { For } from "solid-js";
import type { ToolConfig } from "../types";
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
      return <section class="agent-tool-group" aria-label={`${group.name} tools`}>
        <h4>{group.name}</h4>
        <div class="agent-tool-group-members"><For each={members()}>{renderTool}</For></div>
      </section>;
    }}</For>
  </>;
}
