import { useEffect, useId, useRef, useState } from "react";

interface Props {
  name: string;
  path: string;
  conversationCount: number;
  onRemove: (deleteBranch: boolean) => Promise<void>;
  onCancel: () => void;
}

export function RemoveWorktreeDialog({ name, path, conversationCount, onRemove, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); returnFocus?.focus(); };
  }, []);
  const remove = async () => {
    if (pendingRef.current || conversationCount > 0) return;
    pendingRef.current = true; setPending(true); setError(undefined);
    try { await onRemove(deleteBranch); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onCancel(); }}>
    <h2 id={titleId}>Delete worktree “{name}”?</h2>
    <p id={descriptionId}>Cleanup scripts will run before Git removes <code>{path}</code>. The operation stops if cleanup fails or the worktree contains changes.</p>
    {conversationCount > 0 && <p className="dialog-error" role="alert">Archive or relocate the {conversationCount} conversation{conversationCount === 1 ? "" : "s"} using this worktree first.</p>}
    <label className="dialog-checkbox"><input type="checkbox" checked={deleteBranch} disabled={pending || conversationCount > 0} onChange={(event) => setDeleteBranch(event.target.checked)} /><span>Also delete the branch if Git considers it merged</span></label>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button autoFocus disabled={pending} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={pending || conversationCount > 0} onClick={() => void remove()}>{pending ? "Deleting…" : "Delete worktree"}</button></div>
  </dialog>;
}
