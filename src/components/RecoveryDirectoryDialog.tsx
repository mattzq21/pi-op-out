import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { createRef } from "../lib/solid";
import { inspectRecoveryDirectory, migrateRecoveryDirectory, type RecoveryInspection, type RecoveredDirectory } from "../lib/sessionRecovery";
import type { SessionSummary } from "../types";

export function RecoveryDirectoryDialog(props: {
  session: Pick<SessionSummary, "name" | "path" | "cwd" | "hostId">;
  onCancel: () => void;
  onOpen?: (result: RecoveredDirectory) => Promise<void>;
}) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const [inspection, setInspection] = createSignal<RecoveryInspection>();
  const [result, setResult] = createSignal<RecoveredDirectory>();
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const titleId = createUniqueId();

  const inspect = async () => {
    const value = await inspectRecoveryDirectory(props.session.path, props.session.hostId);
    setInspection(value);

    if (value.currentRecovery) setResult({ cwd: value.cwd, recovery: value.currentRecovery, warnings: [] });
  };

  onMount(() => {
    dialogRef.current?.showModal();
    void inspect().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
  });

  const migrate = async () => {
    if (busy()) return;
    setBusy(true); setError("");

    try { setResult(await migrateRecoveryDirectory(props.session.path, props.session.hostId)); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await inspect().catch(() => {});
    }
    finally { setBusy(false); }
  };

  const open = async () => {
    const recovered = result();

    if (busy() || !recovered || !props.onOpen) return;
    setBusy(true); setError("");

    try { await props.onOpen(recovered); }
    catch (reason) { setError(`The files are kept at ${recovered.cwd}. ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { setBusy(false); }
  };

  const canMigrate = () => inspection()?.legacyRecovery === "available" || Boolean(inspection()?.stagedDirectory);

  const incompleteDirectories = () => inspection()?.retainedDirectories.filter(directory => directory.state === "allocated") ?? [];

  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog missing-directory-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();

    if (!busy()) props.onCancel();
  }}>
    <h2 id={titleId}>Move recovery directory</h2>
    <p>“{props.session.name}” {result() ? "has a durable recovery directory." : "uses a temporary recovery directory."}</p>
    <Show when={!result()}><code class="missing-directory-path">{props.session.cwd}</code></Show>
    <Show when={result()} fallback={<>
      <p>Move its surviving contents into Piop’s managed recovery storage on this session’s machine. The original temporary files will be retained.</p>
      <Show when={loading()}><p role="status">Checking recovery files…</p></Show>
      <Show when={!loading() && inspection() && !canMigrate()}><p role="status">The temporary directory and any verified recovery copy are missing. Its files cannot be migrated. Open the chat to choose an empty directory or the latest remote branch.</p></Show>
      <Show when={inspection()?.stagedDirectory}><p>A verified durable copy is available. Migration will use it if the temporary directory is gone.</p></Show>
    </>}>{recovered => <>
      <p>The chat now uses this durable directory:</p>
      <code class="missing-directory-path">{recovered().cwd}</code>
      <Show when={recovered().warnings.length}><p role="status">{recovered().warnings.join("\n")}</p></Show>
    </>}</Show>
    <Show when={incompleteDirectories().length}>
      <p>Earlier recovery attempts have retained directories below. They may contain incomplete files and are not verified recovery copies.</p>
      <For each={incompleteDirectories()}>{directory => <code class="missing-directory-path">{directory.directory}</code>}</For>
    </Show>
    <Show when={error()}><p class="dialog-error" role="alert">{error()}</p></Show>
    <Show when={busy()}><p role="status">{result() ? "Opening chat…" : "Moving recovery files…"}</p></Show>
    <div class="dialog-actions">
      <button disabled={busy()} onClick={props.onCancel}>{result() ? "Close" : "Cancel"}</button>
      <Show when={result()} fallback={<button class="primary-button" disabled={busy() || loading() || !canMigrate()} onClick={() => void migrate()}>Move recovery directory</button>}>
        <Show when={props.onOpen}><button class="primary-button" disabled={busy()} onClick={() => void open()}>Open chat</button></Show>
      </Show>
    </div>
  </dialog>;
}
