import { createSignal, Show } from "solid-js";
import { ChevronRight, Target } from "lucide-solid";
import { textOf } from "../lib/content";
import type { ChatMessage } from "../types";

/** The goal prompt that the goal sent as a user message to continue its work. Its full text opens on request. */
export function GoalPrompt(props: { message: ChatMessage }) {
  const [open, setOpen] = createSignal(false);

  return <article class="message user-message goal-prompt" aria-label="Goal prompt">
    <div class="message-body">
      <button type="button" class="goal-prompt-toggle" aria-expanded={open()} onClick={() => setOpen(value => !value)}><Target size={14} aria-hidden="true" /><span>Continue goal</span><ChevronRight size={12} class="goal-prompt-chevron" aria-hidden="true" /></button>
      <Show when={open()}><div class="goal-prompt-text">{textOf(props.message.content)}</div></Show>
    </div>
  </article>;
}
