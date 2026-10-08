import { For, Show } from "solid-js";
import type { AgentProfile, AppSettings } from "../types";
import defaultPrompt from "../../../daemon/resources/session-broker/review-prompt.txt?raw";

export function ReviewSettings(props: { settings: AppSettings; agents: AgentProfile[]; onChange: (patch: Partial<AppSettings>) => void }) {
  const selected = () => props.settings.reviewAgent ?? "general";
  const available = () => props.agents.some(agent => agent.name === selected());

  return <>
    <label class="field"><span>Review agent</span><select aria-label="Review agent" value={selected()} onChange={event => props.onChange({ reviewAgent: event.currentTarget.value })}>
      <Show when={!available()}><option value={selected()} disabled>Unavailable: {selected()}</option></Show>
      <For each={props.agents}>{agent => <option value={agent.name}>{agent.name}</option>}</For>
    </select></label>
    <label class="field"><span>Review prompt</span><textarea aria-label="Review prompt" rows={12} value={props.settings.reviewPrompt ?? defaultPrompt.trim()} onInput={event => props.onChange({ reviewPrompt: event.currentTarget.value })} /></label>
    <button class="secondary-button" type="button" onClick={() => props.onChange({ reviewPrompt: defaultPrompt.trim() })}>Restore default prompt</button>
  </>;
}
