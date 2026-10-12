import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Check, ChevronDown, Plus } from "lucide-solid";
import type { RegularChat } from "./chatSchemas";

export function ChatHistoryPicker(props: { chats: RegularChat[]; selected?: RegularChat; disabled: boolean; onSelect: (id?: string) => void }) {
  const [open, setOpen] = createSignal(false);
  let container: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const close = () => { setOpen(false); trigger?.focus(); };
  /** Rows are keyed by chat ID, so a new copy of a chat updates its row in place and keeps keyboard focus. */
  const ids = createMemo(() => props.chats.map(chat => chat.id), [], { equals: (left, right) => left.length === right.length && left.every((id, index) => id === right[index]) });
  const byId = createMemo(() => new Map(props.chats.map(chat => [chat.id, chat])));

  const choose = (id?: string) => { close(); props.onSelect(id); };

  const expand = () => {
    setOpen(true);
    queueMicrotask(() => menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
  };

  const navigate = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); close();

    return; }

    const buttons = [...(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const current = buttons.findIndex(button => button === document.activeElement);
    const next = menuIndex(event.key, current, buttons.length);

    if (next < 0) return;
    event.preventDefault(); buttons[next]?.focus();
  };

  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (container && !event.composedPath().includes(container)) setOpen(false); };

    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });
  createEffect(() => { if (props.disabled) setOpen(false); });

  return <div class="quick-chat-history" ref={container} onFocusOut={event => { if (event.relatedTarget instanceof Node && !container?.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" class="quick-chat-history-trigger" aria-label="ChatGPT chat" aria-haspopup="menu" aria-expanded={open()} disabled={props.disabled}
      onClick={() => { if (open()) setOpen(false); else expand(); }} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); expand(); } }}>
      <span>{props.selected?.title ?? "New chat"}</span><ChevronDown size={14} />
    </button>
    <Show when={open()}><div ref={menu} class="quick-chat-history-menu" role="menu" aria-label="ChatGPT chats" onKeyDown={navigate}>
      <button type="button" role="menuitemradio" aria-checked={!props.selected} class="quick-chat-history-new" onClick={() => choose()}><Plus size={15} /><span>New chat</span></button>
      <For each={ids()}>{id => {
        const chat = createMemo(() => byId().get(id));
        const title = () => chat()?.title;
        const diagnostic = createMemo(() => chat()?.storageDiagnostic?.message);

        return <div><button type="button" role="menuitemradio" disabled={Boolean(diagnostic())} aria-checked={props.selected?.id === id} onClick={() => choose(id)}>
          <span>{title()}</span><Show when={props.selected?.id === id}><Check size={14} /></Show>
        </button><Show when={diagnostic()}>{message => <p role="alert">{message()}</p>}</Show></div>;
      }}</For>
    </div></Show>
  </div>;
}

function menuIndex(key: string, current: number, count: number) {
  if (!count) return -1;

  switch (key) {
    case "Home": return 0;
    case "End": return count - 1;
    case "ArrowDown": return (current + 1) % count;
    case "ArrowUp": return (current + count - 1) % count;
    default: return -1;
  }
}
