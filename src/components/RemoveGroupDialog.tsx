import { useEffect, useId, useRef, useState } from "react";

export function RemoveGroupDialog({ name, onRemove, onCancel }: { name: string; onRemove: () => Promise<void>; onCancel: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
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
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(undefined);
    try { await onRemove(); }
    catch (reason) { setError(String(reason)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onCancel(); }}>
    <h2 id={titleId}>Remove group “{name}”?</h2>
    <p id={descriptionId}>All its chats will move outside all groups. No chats or directories will be deleted.</p>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button autoFocus disabled={pending} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={pending} onClick={() => void remove()}>{pending ? "Removing…" : "Remove group"}</button></div>
  </dialog>;
}
