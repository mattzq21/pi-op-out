import { createSignal, onMount } from "solid-js";
import type { SessionSummary } from "../types";

export interface MissingDirectoryRequest {
  session: SessionSummary;
  recover: (action: "remote" | "empty", repository: string, branch: string) => Promise<void | { missingFields: string[] }>;
  cancel: () => void;
}

export function MissingDirectoryDialog(props: { request: MissingDirectoryRequest }) {
  let dialog!: HTMLDialogElement;
  const [repository, setRepository] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const [fields, setFields] = createSignal<string[]>([]);
  const [remoteFailed, setRemoteFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(() => dialog.showModal());
  const recover = async (action: "remote" | "empty") => {
    if (busy()) return;
    setBusy(true); setError(""); setRemoteFailed(false);
    try {
      const result = await props.request.recover(action, repository(), branch());
      if (result) {
        setFields(current => [...new Set([...current, ...result.missingFields])]);
        setError("Saved recovery details are incomplete. Enter the missing information below and try again.");
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setRemoteFailed(action === "remote"); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} class="extension-dialog missing-directory-dialog" aria-labelledby="missing-directory-title" onCancel={(event) => { event.preventDefault(); if (!busy()) props.request.cancel(); }}>
    <h2 id="missing-directory-title">Working directory is missing</h2>
    <p>“{props.request.session.name}” has not been loaded. Choose how to recover its working directory.</p>
    <code class="missing-directory-path">{props.request.session.cwd}</code>
    <p>Recover a branch from its remote into a new workdir, or continue in an empty directory under /tmp on this session’s machine.</p>
    {fields().includes("repository") && <label class="field"><span>Remote repository URL or existing local checkout</span><input value={repository()} disabled={busy()} onInput={(event) => setRepository(event.currentTarget.value)} /></label>}
    {fields().includes("branch") && <label class="field"><span>Branch</span><input value={branch()} disabled={busy()} onInput={(event) => setBranch(event.currentTarget.value)} /></label>}
    {error() && <p class="dialog-error" role="alert">{error()}</p>}
    {remoteFailed() && fields().length < 2 && <button disabled={busy()} onClick={() => setFields(["repository", "branch"])}>Edit recovery details</button>}
    {busy() && <p role="status">Recovering working directory…</p>}
    <div class="dialog-actions"><button disabled={busy()} onClick={props.request.cancel}>Cancel</button><button disabled={busy()} onClick={() => void recover("empty")}>Create empty workdir</button><button class="primary-button" disabled={busy()} onClick={() => void recover("remote")}>Recover remote branch</button></div>
  </dialog>;
}
