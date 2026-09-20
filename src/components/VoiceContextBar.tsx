import { createMemo, createSignal, For } from "solid-js";
import type { VoicePromptContext } from "../types";

const sections = [
  { key: "systemPrompt", label: "Voice prompt", color: "system" },
  { key: "workspace", label: "Workspace", color: "instructions" },
  { key: "conversation", label: "Conversation", color: "tools" },
  { key: "feedback", label: "Pi feedback", color: "skills" },
] as const;

export function VoiceContextBar(props: { context?: VoicePromptContext }) {
  const [active, setActive] = createSignal<keyof VoicePromptContext>();
  const tokens = createMemo(() => sections.map(section => Math.ceil((props.context?.[section.key]?.length ?? 0) / 4)));
  const total = createMemo(() => tokens().reduce((sum, count) => sum + count, 0));
  const boundary = (end: number) => total() ? `${tokens().slice(0, end).reduce((sum, count) => sum + count, 0) / total() * 100}%` : "0%";
  const tooltip = () => props.context ? `Recorded text context: approximately ${total().toLocaleString()} tokens. Excludes audio and service-side context; conversation and Pi feedback show the most recent 16,000 characters each.` : "Voice context was not recorded for this call.";
  return <section class={`prompt-context voice-context${active() ? " open" : ""}`} aria-label="Voice agent context">
    <div class="prompt-context-bar">
      <For each={sections}>{section => <button class={section.color} aria-expanded={active() === section.key} onClick={() => setActive(current => current === section.key ? undefined : section.key)}>{section.label}</button>}</For>
      <span class="prompt-context-wheel" title={tooltip()} aria-label={tooltip()} tabIndex={0} style={{ "--prompt-system": boundary(1), "--prompt-instructions": boundary(2), "--prompt-tools": boundary(3) }} />
    </div>
    {active() && <div class="prompt-context-content"><pre>{props.context ? props.context[active()!] || "None" : "Voice context was not recorded for this call. Start a new call with the updated daemon to capture it."}</pre></div>}
  </section>;
}
