import { createSignal, createUniqueId } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

interface Props {
  name: string;
  path: string;
  conversationCount: number;
  onRemove: (deleteBranch: boolean) => Promise<void>;
  onCancel: () => void;
}

export function RemoveWorktreeDialog(componentProps: Props) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const pendingRef = createRef(false);
  const [pending, setPending] = createSignal(false);
  const [deleteBranch, setDeleteBranch] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); returnFocus?.focus(); };
  }, () => []);
  const remove = async () => { const capturedDeleteBranch = deleteBranch(); const capturedConversationCount0 = componentProps.conversationCount; const capturedOnRemove1 = componentProps.onRemove;
    if (pendingRef.current || capturedConversationCount0 > 0) return;
    pendingRef.current = true; setPending(true); setError(undefined);
    try { await capturedOnRemove1(capturedDeleteBranch); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) componentProps.onCancel(); }}>
    <h2 id={titleId}>Delete worktree “{componentProps.name}”?</h2>
    <p id={descriptionId}>Cleanup scripts will run before Git removes <code>{componentProps.path}</code>. The operation stops if cleanup fails or the worktree contains changes.</p>
    {componentProps.conversationCount > 0 && <p class="dialog-error" role="alert">Archive or relocate the {componentProps.conversationCount} conversation{componentProps.conversationCount === 1 ? "" : "s"} using this worktree first.</p>}
    <label class="dialog-checkbox"><input type="checkbox" checked={deleteBranch()} disabled={pending() || componentProps.conversationCount > 0} onInput={(event) => setDeleteBranch(event.target.checked)} /><span>Also delete the branch if Git considers it merged</span></label>
    {error() && <p class="dialog-error" role="alert">{(error())!}</p>}
    <div class="dialog-actions"><button autofocus disabled={pending()} onClick={componentProps.onCancel}>Cancel</button><button class="primary-button" disabled={pending() || componentProps.conversationCount > 0} onClick={() => void remove()}>{pending() ? "Deleting…" : "Delete worktree"}</button></div>
  </dialog>;
}
