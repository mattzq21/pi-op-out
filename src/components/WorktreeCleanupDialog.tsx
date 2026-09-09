import { useEffect, useRef, useState } from "react";

export function WorktreeCleanupDialog({ path, onRun, onClose }: { path: string; onRun: (onCancel: (cancel: (() => Promise<void>) | undefined) => void) => Promise<void>; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [cancelRun, setCancelRun] = useState<() => Promise<void>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current; dialog?.showModal();
    return () => { dialog?.close(); focus?.focus(); };
  }, []);
  const cancel = async () => {
    if (!pendingRef.current) { onClose(); return; }
    try { await cancelRun?.(); } catch (reason) { setError(String(reason)); }
  };
  const run = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(undefined);
    try { await onRun((cancel) => setCancelRun(() => cancel)); onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby="cleanup-title" onCancel={(event) => { event.preventDefault(); void cancel(); }}>
    <h2 id="cleanup-title">Clean up worktree</h2>
    <p>Run this project’s enabled cleanup scripts in <code>{path}</code>. The scripts determine what is removed; piop keeps the worktree and its group.</p>
    {pending && <p role="status">Running cleanup scripts…</p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={pending && !cancelRun} onClick={() => void cancel()}>{pending ? "Cancel cleanup" : "Cancel"}</button><button className="primary-button" disabled={pending} onClick={() => void run()}>{pending ? "Cleaning up…" : "Run cleanup"}</button></div>
  </dialog>;
}
