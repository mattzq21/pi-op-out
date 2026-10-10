import { createUniqueId, onMount, onCleanup } from "solid-js";
import { createRef } from "../lib/solid";

export function DeleteArchivesDialog(props: { count: number; hostName: string; includesTemporaryFolder: boolean; onConfirm: () => void; onCancel: () => void }) {
  const dialog = createRef<HTMLDialogElement>(null);
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();

  onMount(() => {
    const returnFocus = document.activeElement;
    dialog.current?.showModal();
    onCleanup(() => {
      dialog.current?.close();

      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    });
  });

  return <dialog ref={element => { dialog.current = element; }} class="extension-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); props.onCancel(); }}>
    <h2 id={titleId}>Delete archived conversations?</h2>
    <p id={descriptionId}>Permanently delete {props.count} archived conversations on {props.hostName}, including their attached reviews and subagents?{props.includesTemporaryFolder ? " Temporary folders that no other chat uses will also be deleted, with all their files." : ""} Forks are only deleted if selected themselves. This cannot be undone.</p>
    <div class="dialog-actions"><button autofocus onClick={props.onCancel}>Cancel</button><button class="primary-button" onClick={props.onConfirm}>Delete {props.count} conversations</button></div>
  </dialog>;
}
