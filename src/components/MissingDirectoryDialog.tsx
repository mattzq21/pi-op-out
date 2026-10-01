import { createSignal, onMount } from "solid-js";
import type { SessionSummary } from "../types";

export interface MissingDirectoryRequest {
  session: SessionSummary;
  recover: (action: "remote" | "empty", repository: string, branch: string) => Promise<void>;
  cancel: () => void;
}

export function MissingDirectoryDialog(props: { request: MissingDirectoryRequest }) {
  let dialog!: HTMLDialogElement;
  const [repository, setRepository] = createSignal(props.request.session.projectRoot ?? "");
  const [branch, setBranch] = createSignal(props.request.session.branch ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(() => dialog.showModal());
  const recover = async (action: "remote" | "empty") => {
    if (busy()) return;
    setBusy(true); setError("");
    try { await props.request.recover(action, repository(), branch()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} class="extension-dialog missing-directory-dialog" aria-labelledby="missing-directory-title" onCancel={(event) => { event.preventDefault(); if (!busy()) props.request.cancel(); }}>
    <h2 id="missing-directory-title">Working directory is missing</h2>
    <p>“{props.request.session.name}” has not been loaded. Choose how to recover its working directory.</p>
    <code class="missing-directory-path">{props.request.session.cwd}</code>
    <p>Recover a branch from its remote into a new workdir, or continue in an empty directory under /tmp on this session’s machine.</p>
    <label class="field"><span>Remote repository URL or existing local checkout</span><input value={repository()} disabled={busy()} placeholder="Use saved repository information if available" onInput={(event) => setRepository(event.currentTarget.value)} /></label>
    <label class="field"><span>Branch</span><input value={branch()} disabled={busy()} placeholder="Use saved branch information if available" onInput={(event) => setBranch(event.currentTarget.value)} /></label>
    {error() && <p class="dialog-error" role="alert">{error()}</p>}
    {busy() && <p role="status">Recovering working directory…</p>}
    <div class="dialog-actions"><button disabled={busy()} onClick={props.request.cancel}>Cancel</button><button disabled={busy()} onClick={() => void recover("empty")}>Create empty workdir</button><button class="primary-button" disabled={busy()} onClick={() => void recover("remote")}>Recover remote branch</button></div>
  </dialog>;
}
