import { createUniqueId } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

export function RemoveMachineDialog(props: { name: string; onRemove: () => void; onCancel: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();

    return () => { dialog?.close(); returnFocus?.focus(); };
  }, () => []);

  return <dialog ref={(element) => { dialogRef.current = element; }} class="extension-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); props.onCancel(); }}>
    <h2 id={titleId}>Remove machine “{props.name}”?</h2>
    <p id={descriptionId}>After saving, this machine’s conversations will no longer be available here. Its files and conversations will remain on the remote machine.</p>
    <div class="dialog-actions"><button autofocus onClick={props.onCancel}>Cancel</button><button class="primary-button" onClick={props.onRemove}>Remove machine</button></div>
  </dialog>;
}
