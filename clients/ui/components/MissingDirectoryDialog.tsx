import { createSignal, onCleanup, onMount } from "solid-js";
import type { SessionSummary } from "../types";

export interface MissingDirectoryRequest {
  session: SessionSummary;
  recover: () => Promise<void>;
  cancel: () => void;
}

export function MissingDirectoryDialog(props: { request: MissingDirectoryRequest }) {
  let dialog!: HTMLDialogElement;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let active = true;
  onCleanup(() => { active = false; });
  onMount(() => dialog.showModal());

  const recover = async () => {
    if (busy()) return;
    setBusy(true); setError("");

    try { await props.request.recover(); }
    catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (active) setBusy(false); }
  };

  return <dialog ref={dialog} class="extension-dialog missing-directory-dialog" aria-labelledby="missing-directory-title" onCancel={(event) => { event.preventDefault();

    if (!busy()) props.request.cancel(); }}>
    <h2 id="missing-directory-title">Working directory is missing</h2>
    <p>“{props.request.session.name}” has not been loaded.</p>
    <code class="missing-directory-path">{props.request.session.cwd}</code>
    <p>Continue the chat in a new empty folder on this session’s host. This keeps the chat history. Missing files will not be restored.</p>
    {error() && <p class="dialog-error" role="alert">{error()}</p>}
    {busy() && <p role="status">Creating folder…</p>}
    <div class="dialog-actions"><button disabled={busy()} onClick={props.request.cancel}>Cancel</button><button class="primary-button" disabled={busy()} onClick={() => void recover()}>Create empty folder</button></div>
  </dialog>;
}
