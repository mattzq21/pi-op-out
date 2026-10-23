import { createSignal, createUniqueId } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

export function RemoveGroupDialog(componentProps: { name: string; onRemove: () => Promise<void>; onCancel: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const pendingRef = createRef(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();

    return () => { dialog?.close(); returnFocus?.focus(); };
  }, () => []);

  const remove = async () => { const capturedOnRemove0 = componentProps.onRemove;

    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(undefined);

    try { await capturedOnRemove0(); }
    catch (reason) { setError((reason instanceof Error ? reason.message : String(reason))); }
    finally { pendingRef.current = false; setPending(false); }
  };

  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault();

  if (!pendingRef.current) componentProps.onCancel(); }}>
    <h2 id={titleId}>Forget group “{componentProps.name}”?</h2>
    <p id={descriptionId}>All its chats will move outside all groups. No chats or directories will be deleted.</p>
    {error() && <p class="dialog-error" role="alert">{(error())}</p>}
    <div class="dialog-actions"><button autofocus disabled={pending()} onClick={componentProps.onCancel}>Cancel</button><button class="primary-button" disabled={pending()} onClick={() => void remove()}>{pending() ? "Forgetting…" : "Forget group"}</button></div>
  </dialog>;
}
