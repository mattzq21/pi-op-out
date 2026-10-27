import { For, Show } from "solid-js";
import type { PluginSettingsProps } from "../types";

/** The OpenAI model that answers web_search on this host. */
export function WebSearchSettings(props: PluginSettingsProps) {
  const selected = () => props.settings.webSearchModel ?? "gpt-6.1-sol";
  const models = () => props.models.filter(model => model.provider === "openai");
  const available = () => models().some(model => model.id === selected());

  return <label class="field"><span>Search model</span><select aria-label="Search model" value={selected()} onChange={event => props.onChange({ webSearchModel: event.currentTarget.value })}>
    <Show when={!available()}><option value={selected()} disabled>Unavailable: {selected()}</option></Show>
    <For each={models()}>{model => <option value={model.id}>{model.name || model.id}</option>}</For>
  </select></label>;
}
