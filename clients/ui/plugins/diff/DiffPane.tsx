import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import { textOf } from "../../lib/content";
import { turnDiff } from "../../lib/turnDiff";
import type { ChatMessage } from "../../types";
import type { PluginConversation } from "../types";
import { DiffViewer } from "./DiffViewer";

type DiffResponse = { id: string; prompt: string };

function diffResponses(messages: ChatMessage[]) {
  const responses: DiffResponse[] = [];
  let prompt = "";
  let response: DiffResponse | undefined;

  for (const message of messages) {
    if (message.role === "user" || message.customType === "pi-desktop-btw") {
      if (response) responses.push(response);
      prompt = textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 80);
      response = undefined;
    }

    if (message.role === "assistant" && (textOf(message.content).trim() || message.stopReason === "aborted" || message.stopReason === "error")) response = { id: message.id, prompt };
  }

  if (response) responses.push(response);

  return responses;
}

export function DiffPane(props: { source: Accessor<PluginConversation> }) {
  const [selected, setSelected] = createSignal("");
  const responses = createMemo(() => diffResponses(props.source().messages));
  const response = createMemo(() => responses().find(item => item.id === selected()) ?? responses().at(-1));

  const snapshot = createMemo(() => {
    const id = response()?.id;

    return id ? props.source().gitDiffs?.[id] : undefined;
  });

  const changes = createMemo(() => turnDiff(snapshot()));

  return <section class="diff-pane" aria-label="Conversation file changes">
    <header class="diff-pane-toolbar">
      <strong title={props.source().title}>{props.source().title}</strong>
      <Show when={responses().length}><label>Response<select aria-label="Response changes" value={responses().some(item => item.id === selected()) ? selected() : ""} onChange={event => setSelected(event.currentTarget.value)}>
        <option value="">Latest response</option>
        <For each={responses()}>{(item, index) => <option value={item.id}>{index() + 1}{item.prompt ? `: ${item.prompt}` : ": Agent response"}</option>}</For>
      </select></label></Show>
    </header>
    <Show when={changes().files.length || changes().warnings.length} fallback={<p class="empty-small">{response() ? "No file changes were captured for this response." : "File changes will appear here after an agent response."}</p>}>
      <DiffViewer {...changes()} persistent />
    </Show>
  </section>;
}
