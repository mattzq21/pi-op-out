import { createSignal, For, onMount, Show } from "solid-js";
import type { RecoveryInspection } from "../lib/sessionRecovery";
import type { SessionSummary } from "../types";

export interface MissingDirectoryRequest {
  session: SessionSummary;
  inspect: () => Promise<{ canRecoverRemote: boolean; retainedDirectories?: RecoveryInspection["retainedDirectories"] }>;
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
  const [canRecoverRemote, setCanRecoverRemote] = createSignal(false);
  const [retainedDirectories, setRetainedDirectories] = createSignal<RecoveryInspection["retainedDirectories"]>([]);

  const inspect = async () => {
    const result = await props.request.inspect();
    setCanRecoverRemote(result.canRecoverRemote);
    setRetainedDirectories(result.retainedDirectories ?? []);
  };

  onMount(() => {
    dialog.showModal();
    void inspect().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  });

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
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason)); setRemoteFailed(action === "remote");
      await inspect().catch(() => {});
    }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} class="extension-dialog missing-directory-dialog" aria-labelledby="missing-directory-title" onCancel={(event) => { event.preventDefault();

    if (!busy()) props.request.cancel(); }}>
    <h2 id="missing-directory-title">Working directory is missing</h2>
    <p>“{props.request.session.name}” has not been loaded. Choose how to recover its working directory.</p>
    <code class="missing-directory-path">{props.request.session.cwd}</code>
    <p>The new working directory will be kept in Piop’s managed recovery storage on this session’s machine.</p>
    <p>{canRecoverRemote() ? "Clone the latest version of a remote branch, or continue in a new empty directory. Unpushed commits, uncommitted changes, and other missing local files will not be restored by either option." : "Continue in a new empty directory. Files from the missing directory will not be restored."}</p>
    <Show when={retainedDirectories().some(directory => directory.state === "allocated")}>
      <p>Earlier recovery attempts have retained directories below. They may contain incomplete files and are not verified recovery copies.</p>
      <For each={retainedDirectories().filter(directory => directory.state === "allocated")}>{directory => <code class="missing-directory-path">{directory.directory}</code>}</For>
    </Show>
    {fields().includes("repository") && <label class="field"><span>Remote repository URL or existing local checkout</span><input value={repository()} disabled={busy()} onInput={(event) => setRepository(event.currentTarget.value)} /></label>}
    {fields().includes("branch") && <label class="field"><span>Branch</span><input value={branch()} disabled={busy()} onInput={(event) => setBranch(event.currentTarget.value)} /></label>}
    {error() && <p class="dialog-error" role="alert">{error()}</p>}
    {remoteFailed() && fields().length < 2 && <button disabled={busy()} onClick={() => setFields(["repository", "branch"])}>Edit recovery details</button>}
    {busy() && <p role="status">Recovering working directory…</p>}
    <div class="dialog-actions"><button disabled={busy()} onClick={props.request.cancel}>Cancel</button><button disabled={busy()} onClick={() => void recover("empty")}>Create empty workdir</button>{canRecoverRemote() && <button class="primary-button" disabled={busy()} onClick={() => void recover("remote")}>Clone latest remote branch</button>}</div>
  </dialog>;
}
