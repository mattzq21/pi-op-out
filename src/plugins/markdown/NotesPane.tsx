import { Eye, Pencil } from "lucide-solid";
import { createSignal, Show, type Accessor } from "solid-js";
import { type ChatNoteTarget, useChatNote } from "./useNotes";
import { Markdown } from "../../components/Markdown";
import "./notes.css";

export function NotesPane(props: ChatNoteTarget & { visible: Accessor<boolean> }) {
  const notes = useChatNote({ sessionId: props.sessionId, hostId: props.hostId }, props.visible);
  const [preview, setPreview] = createSignal(false);
  let editor: HTMLTextAreaElement | undefined;
  const focusEditor = () => { setPreview(false); queueMicrotask(() => editor?.focus()); };

  const editorKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation(); void notes.save();
    }
  };

  return <section class="notes-pane" aria-label="Chat note" onKeyDown={editorKeyDown}>
    <Show when={notes.ready() && !notes.editable()}><div class="notes-error" role="status"><span>Read-only </span><button disabled={notes.loading() || notes.saving()} onClick={() => void notes.takeControl()}>Take control</button></div></Show>
    <Show when={notes.error()}><div class="notes-error" role="alert"><span>{notes.error()}</span><button disabled={notes.loading() || notes.saving()} onClick={() => void notes.retry()}>Retry</button></div></Show>
    <div class="notes-editor-toolbar"><div role="group" aria-label="Note mode"><button aria-pressed={!preview()} classList={{ active: !preview() }} onClick={focusEditor}><Pencil size={13} />Edit</button><button aria-pressed={preview()} classList={{ active: preview() }} onClick={() => setPreview(true)}><Eye size={14} />Preview</button></div></div>
    <Show when={preview()} fallback={<textarea ref={editor} class="notes-editor" aria-label="Chat note" placeholder="Write a note for this chat…" value={notes.content()} onInput={event => notes.edit(event.currentTarget.value)} onBlur={() => void notes.save()} readOnly={!notes.editable()} disabled={notes.loading() || !notes.ready()} spellcheck />}>
      <div class="notes-preview"><Markdown>{notes.content()}</Markdown></div>
    </Show>
  </section>;
}
