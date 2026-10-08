import { createMemo, createSignal, For, Show } from "solid-js";
import { legacyNoteDrafts, retireLegacyNoteDraft, type LegacyNoteDraft } from "./legacyNoteDrafts";
import { isMobile } from "../../lib/platform";
import "./notes.css";

export function LegacyNoteDraftRecovery(props: { draft: LegacyNoteDraft; busy: boolean; restoreDisabled?: boolean; savedVersion?: string; onRestore?: () => void }) {
  const [message, setMessage] = createSignal("");
  const savedChanged = () => props.savedVersion !== undefined && props.draft.baseVersion !== undefined && props.savedVersion !== props.draft.baseVersion;

  const copy = async () => {
    try { await navigator.clipboard.writeText(props.draft.content ?? props.draft.stored); setMessage("Draft copied."); }
    catch { setMessage("Could not copy the draft. Select its text below to copy it."); }
  };

  const discard = () => {
    if (!retireLegacyNoteDraft(props.draft)) setMessage("The older draft changed or could not be removed. Review it again before discarding it.");
  };

  return <section class="notes-error" aria-label="Older note draft">
    <p>An older version of Piop saved a note draft on this device for host {props.draft.target.hostId}, conversation {props.draft.target.sessionId}. Confirm it belongs to this conversation before restoring it.</p>
    <Show when={isMobile}><p>The original connected host was not recorded. Check the draft text before choosing where to restore it.</p></Show>
    <Show when={savedChanged()}><p>The saved note has changed since this draft was written. Review both versions before saving.</p></Show>
    <Show when={props.draft.content === undefined}><p>The draft format could not be recognized. You can copy its stored text for recovery.</p></Show>
    <details><summary>Review older draft</summary><pre>{props.draft.content ?? props.draft.stored}</pre></details>
    <Show when={props.onRestore}><button type="button" disabled={props.busy || props.restoreDisabled || props.draft.content === undefined} onClick={() => props.onRestore?.()}>Restore older draft</button></Show>
    <button type="button" disabled={props.busy} onClick={() => void copy()}>Copy older draft</button>
    <button type="button" disabled={props.busy} onClick={discard}>Discard older draft</button>
    <Show when={message()}><p role="status">{message()}</p></Show>
  </section>;
}

export function LegacyNoteDrafts(props: { busy: boolean }) {
  const drafts = createMemo(() => legacyNoteDrafts());

  return <Show when={drafts().length}><details class="notes-legacy-recovery"><summary>Recover older note drafts</summary><For each={drafts()}>{draft => <LegacyNoteDraftRecovery draft={draft} busy={props.busy} />}</For></details></Show>;
}
