import { createSignal, For, Show } from "solid-js";
import { unavailableNoteDrafts } from "./noteSessions";
import "./notes.css";

export function RetainedNoteDrafts(props: { hostId: string; busy: boolean }) {
  return <For each={unavailableNoteDrafts(props.hostId)}>{session => {
    const [message, setMessage] = createSignal("");

    const copy = async () => {
      try { await navigator.clipboard.writeText(session.note.content()); setMessage("Draft copied."); }
      catch { setMessage("Could not copy the draft. Select its text below to copy it."); }
    };

    const disabled = () => props.busy || session.note.loading() || session.note.saving();

    return <section class="notes-error" aria-label="Unsaved note draft">
      <p>Unsaved note for conversation {session.target.sessionId}. {session.note.deleted() ? "This conversation was deleted." : "Notes are disabled on this host."} Your edits are retained until you save or discard them.</p>
      <details><summary>Review unsaved draft</summary><pre>{session.note.content()}</pre></details>
      <button type="button" disabled={disabled()} onClick={() => void copy()}>Copy draft</button>
      <button type="button" disabled={disabled()} onClick={session.note.useSaved}>Discard unsaved edits</button>
      <Show when={message()}><p role="status">{message()}</p></Show>
    </section>;
  }}</For>;
}
