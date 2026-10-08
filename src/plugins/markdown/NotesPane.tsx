import { Show, type Accessor } from "solid-js";
import { type ChatNoteTarget } from "./useNotes";
import { useNoteSession } from "./noteSessions";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor";
import "./notes.css";

export function NotesPane(props: ChatNoteTarget & { visible: Accessor<boolean> }) {
  const notes = useNoteSession({ sessionId: props.sessionId, hostId: props.hostId }, props.visible);

  const editorKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation(); void notes.save();
    }
  };

  const controlsDisabled = () => notes.loading() || notes.saving();

  const renderConflict = () => (<Show when={notes.conflict()}><div class="notes-error" role="alert">
    <span>Your unsaved edits are retained below. Review the saved note before choosing which version to keep.</span>
    <details><summary>Review saved note</summary><pre>{notes.savedContent()}</pre></details>
    <button disabled={controlsDisabled() || !notes.ready() || !notes.owned()} onClick={() => void notes.saveEdits()}>Save my edits</button>
    <button disabled={controlsDisabled()} onClick={notes.useSaved}>Use saved note</button>
  </div></Show>);

  return <section class="notes-pane" aria-label="Chat note" onKeyDown={editorKeyDown}>
    <Show when={notes.deleted()}><div class="notes-error" role="status">This conversation was permanently deleted.</div></Show>
    <Show when={notes.disabled()}><div class="notes-error" role="status">Markdown notes are disabled on this host.</div></Show>
    <Show when={notes.ready() && !notes.owned()}><div class="notes-error" role="status"><span>Read-only </span><button disabled={controlsDisabled()} onClick={() => void notes.takeControl()}>Take control</button></div></Show>
    {renderConflict()}
    <Show when={notes.error() && !notes.conflict()}><div class="notes-error" role="alert"><span>{notes.error()}</span><button disabled={controlsDisabled()} onClick={() => void notes.retry()}>Retry</button></div></Show>
    <LiveMarkdownEditor content={notes.content()} editable={notes.editable() && notes.ready()} visible={props.visible()} onChange={notes.edit} onSave={() => void notes.save()} />
    <Show when={notes.ready() && notes.editable()}><div class="notes-save-status" role="status">{notes.error() ? "Not saved" : notes.saving() || notes.dirty() ? "Saving…" : "Saved"}</div></Show>
  </section>;
}
