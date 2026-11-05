import { For, Show } from "solid-js";
import type { PluginSettingsProps } from "piop/plugin";

const providers = [{ id: "openai", label: "OpenAI (ChatGPT sign-in)" }, { id: "anthropic", label: "Anthropic (Claude Pro/Max sign-in)" }];

export function WebSearchSettings(props: PluginSettingsProps) {
  const selected = () => typeof props.settings.webSearchModel === "string" ? props.settings.webSearchModel : "openai/gpt-6.1-sol";
  const models = (provider: string) => props.models.filter(model => model.provider === provider);
  const available = () => props.models.some(model => `${model.provider}/${model.id}` === selected());

  return <label class="field"><span>Search model</span><select aria-label="Search model" value={selected()} onChange={event => props.onChange({ webSearchModel: event.currentTarget.value })}>
    <Show when={!available()}><option value={selected()} disabled>Unavailable: {selected()}</option></Show>
    <For each={providers}>{provider => <Show when={models(provider.id).length}>
      <optgroup label={provider.label}><For each={models(provider.id)}>{model => <option value={`${model.provider}/${model.id}`}>{model.name || model.id}</option>}</For></optgroup>
    </Show>}</For>
  </select></label>;
}
