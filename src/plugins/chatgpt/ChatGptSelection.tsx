import { createSignal, Show, type Accessor } from "solid-js";
import { captureChatGptContext, type ChatGptContextSource } from "./context";
import { createDependencyEffect, cssPixels } from "../../lib/solid";
import { isMobile } from "../../lib/platform";
import "./selection-tip.css";

type SelectedText = { text: string; source: string; left: number; top: number; below: boolean };

function sourceMessage(range: Range, messages: HTMLElement) {
  const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const body = ancestor?.closest(".message-body");

  if (!body || !messages.contains(body) || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return;

  return body;
}

function selectedMessage(messages: HTMLElement | null) {
  const selection = window.getSelection();

  if (!messages || !selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const body = sourceMessage(range, messages);

  if (!body) return;
  const text = selection.toString().trim();
  const rect = range.getClientRects()[0];

  if (!text || !rect) return;
  const below = rect.top < 48;

  return { text, source: body.textContent ?? text, below,
    left: Math.max(112, Math.min(rect.left + rect.width / 2, window.innerWidth - 112)),
    top: below ? rect.bottom + 8 : rect.top - 8 };
}

export function ChatGptSelection(props: { messages: Accessor<HTMLElement | null>; source: Accessor<ChatGptContextSource>; onAsk: (source: ChatGptContextSource) => void }) {
  const [selected, setSelected] = createSignal<SelectedText>();
  createDependencyEffect(() => {
    const update = () => setSelected(selectedMessage(props.messages()));
    const dismiss = () => setSelected(undefined);
    document.addEventListener("selectionchange", update);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);

    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, () => []);

  const open = () => {
    const selection = selected();
    const start = props.onAsk;

    if (!selection) return;
    start(captureChatGptContext(() => ({ ...props.source(), selected: selection })));
    window.getSelection()?.removeAllRanges();
    setSelected(undefined);
  };

  return <Show when={selected()}>{selection => <div class={`selection-chatgpt-tip${selection().below ? " below" : ""}${isMobile ? " mobile" : ""}`} style={{ left: cssPixels(selection().left), top: cssPixels(selection().top) }} onPointerDown={event => event.preventDefault()}>
    <button type="button" onClick={open}>Ask ChatGPT</button>
  </div>}</Show>;
}
