import { For, Show, createEffect } from "solid-js";
import { Plus, RefreshCw, Send, Square } from "lucide-solid";
import { IconButton } from "../../components/IconButton";
import { Markdown } from "../../components/Markdown";
import { useChatGpt, type QuickChatRequest } from "./useChatGpt";
import "./quick-chat.css";

export function QuickChat(props: { request?: QuickChatRequest; open: boolean; onNew: () => void }) {
  const state = useChatGpt(() => props.request, () => props.open);
  let messages: HTMLDivElement | undefined;
  let composer: HTMLTextAreaElement | undefined;
  let follow = true;
  const active = () => state.busy() || state.responding();
  const status = () => state.chat()?.status === "stopping" ? "Stopping…" : state.busy() ? "Preparing…" : "Responding…";
  createEffect(() => {
    state.chat();
    queueMicrotask(() => { if (messages && follow) messages.scrollTop = messages.scrollHeight; });
  });
  createEffect(() => { if (props.open) queueMicrotask(() => composer?.focus()); });

  const renderChatPicker = () => <select class="quick-chat-history" aria-label="ChatGPT chat" disabled={state.busy() || state.loading()} onChange={event => { follow = true;

      if (event.currentTarget.value) void state.select(event.currentTarget.value); else { props.onNew(); state.fresh(); } }}>
        <option value="" selected={!state.chat()}>New chat</option><For each={state.chats()}>{chat => <option value={chat.id} selected={state.chat()?.id === chat.id}>{chat.title}</option>}</For>
      </select>;

  const renderSelection = () => <Show when={!state.chat() && state.source()?.selected}><blockquote class="quick-chat-selection">{state.source()?.selected?.text.slice(0, 300)}</blockquote></Show>;

  const renderMessages = () => <div class="quick-chat-messages" ref={messages} onScroll={() => { if (messages) follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80; }} aria-busy={active()}>
      <Show when={state.chat()?.messages.length}>
        <For each={state.chat()?.messages}>{message => <article class={`quick-chat-message ${message.role}`}>
          <strong>{message.role === "user" ? "You" : "ChatGPT"}</strong><Markdown streaming={message.role === "assistant" && active()}>{message.text}</Markdown>
        </article>}</For>
      </Show>
      <Show when={active()}><p role="status" class="quick-chat-status">{status()}</p></Show>
    </div>;

  const renderComposer = () => <form class="quick-chat-composer" onSubmit={event => { event.preventDefault(); follow = true; void state.send(); }}>
      <textarea ref={composer} aria-label="Message ChatGPT" placeholder="Message ChatGPT" value={state.prompt()} maxLength={100000} disabled={state.busy()} readOnly={!state.editable()} onInput={event => state.setPrompt(event.currentTarget.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); follow = true; void state.send(); }
      }} />
      <div class="quick-chat-controls">{renderModelControls()}
        <Show when={active()} fallback={<button type="submit" aria-label="Send to ChatGPT" disabled={!state.editable() || !state.prompt().trim() || state.loading() || !state.models().length}><Send size={17} /></button>}>
          <button type="button" aria-label="Stop ChatGPT" disabled={!state.editable() || state.chat()?.status === "stopping"} onClick={() => void state.stop()}><Square size={16} /></button>
        </Show>
      </div>
    </form>;

  const renderModelControls = () => <Show when={state.models().length}>
    <div class="quick-chat-model-controls">
      <div class="quick-chat-picker"><select aria-label="ChatGPT model" value={state.modelSelection.selection().versionId} disabled={active()} onChange={event => state.modelSelection.setVersion(event.currentTarget.value)}>
        <For each={state.models()}>{model => <option value={model.id}>{model.name}</option>}</For>
      </select></div>
      <div class="quick-chat-picker"><select aria-label="ChatGPT thinking level" value={state.modelSelection.index()} disabled={active()} onChange={event => state.modelSelection.setIndex(Number(event.currentTarget.value))}>
        <For each={state.modelSelection.presets()}>{(preset, index) => <option value={index()}>{preset.name}</option>}</For>
      </select></div>
    </div>
  </Show>;

  return <section class="quick-chat" aria-label="ChatGPT quick chat">
    <header class="quick-chat-header">{renderChatPicker()}
      <IconButton label="New ChatGPT chat" disabled={state.busy()} onClick={() => { props.onNew(); state.fresh(); follow = true; }}><Plus size={17} /></IconButton>
      <IconButton label="Refresh ChatGPT" disabled={active()} onClick={state.refresh}><RefreshCw size={16} /></IconButton>
    </header>
    {renderSelection()}{renderMessages()}
    <Show when={!state.editable()}><p class="quick-chat-error" role="status">Read-only · waiting for editing access.</p></Show>
    <Show when={state.error() || state.chat()?.error}><div class="quick-chat-error" role="alert">{state.error() || state.chat()?.error}</div></Show>
    {renderComposer()}
  </section>;
}
