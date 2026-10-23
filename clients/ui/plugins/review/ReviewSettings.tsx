import { For, Show } from "solid-js";
import type { PluginSettingsProps } from "../types";

/** The agent that runs /review, chosen in the Agents settings tab. */
export function ReviewSettings(props: PluginSettingsProps) {
  const selected = () => props.settings.reviewAgent ?? "general";
  const available = () => props.agents.some(agent => agent.name === selected());

  return <label class="field"><span>Review agent</span><select aria-label="Review agent" value={selected()} onChange={event => props.onChange({ reviewAgent: event.currentTarget.value })}>
    <Show when={!available()}><option value={selected()} disabled>Unavailable: {selected()}</option></Show>
    <For each={props.agents}>{agent => <option value={agent.name}>{agent.name}</option>}</For>
  </select></label>;
}
