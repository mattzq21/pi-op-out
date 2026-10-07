import { Eye, Pencil } from "lucide-solid";
import { createSignal, For, Show, type Accessor } from "solid-js";
import { type ChatNoteTarget } from "./useNotes";
import { useNoteSession } from "./noteSessions";
import { Markdown } from "../../components/Markdown";
import "./notes.css";

export function NotesPane(props: ChatNoteTarget & { visible: Accessor<boolean> }) {
  const notes = useNoteSession({ sessionId: props.sessionId, hostId: props.hostId }, props.visible);
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
    <Show when={notes.deleted()}><div class="notes-error" role="status">This conversation was permanently deleted.</div></Show>
    <Show when={notes.disabled()}><div class="notes-error" role="status">Markdown notes are disabled on this host.</div></Show>
    <Show when={notes.ready() && !notes.editable()}><div class="notes-error" role="status"><span>Read-only </span><button disabled={notes.loading() || notes.saving()} onClick={() => void notes.takeControl()}>Take control</button></div></Show>
    <Show when={notes.error()}><div class="notes-error" role="alert"><span>{notes.error()}</span><button disabled={notes.loading() || notes.saving()} onClick={() => void notes.retry()}>Retry</button></div></Show>
    <Show when={notes.dirty()}><div class="notes-error" role="status">
      <span>{notes.conflict() ? "The saved note changed. Your edit is preserved below. Choose which version to keep." : notes.durable() ? "Your unsaved edit has a recovery copy on this device." : "Preserving your unsaved edit…"}</span>
      <div class="notes-recovery-actions"><button disabled={!notes.editable() || notes.saving()} onClick={() => void notes.useLocal()}>{notes.conflict() ? "Save my edit instead" : "Save my edit"}</button><button disabled={notes.loading() || notes.saving()} onClick={notes.useSaved}>Use saved note</button></div>
      <Show when={notes.conflict()}><details><summary>Compare with saved note</summary><textarea class="notes-recovery-content" aria-label="Saved note" value={notes.savedContent()} readOnly /></details></Show>
    </div></Show>
    <For each={notes.recoveries()}>{value => <details class="notes-error"><summary>Recovered edit {value.updatedAt ? new Date(value.updatedAt).toLocaleString() : "from an earlier version"}</summary><textarea class="notes-recovery-content" aria-label="Recovered note edit" value={value.content} readOnly /><div class="notes-recovery-actions"><button disabled={notes.dirty() || notes.saving() || notes.loading()} onClick={() => notes.restore(value)}>Restore edit</button><button onClick={() => void notes.discardRecovery(value)}>Discard recovery copy</button></div></details>}</For>
    <div class="notes-editor-toolbar"><div role="group" aria-label="Note mode"><button aria-pressed={!preview()} classList={{ active: !preview() }} onClick={focusEditor}><Pencil size={13} />Edit</button><button aria-pressed={preview()} classList={{ active: preview() }} onClick={() => setPreview(true)}><Eye size={14} />Preview</button></div></div>
    <Show when={preview()} fallback={<textarea ref={editor} class="notes-editor" aria-label="Chat note" placeholder="Write a note for this chat…" value={notes.content()} onInput={event => notes.edit(event.currentTarget.value)} onBlur={() => void notes.save()} readOnly={!notes.editable()} disabled={notes.loading() && !notes.dirty()} spellcheck />}>
      <div class="notes-preview"><Markdown>{notes.content()}</Markdown></div>
    </Show>
  </section>;
}
