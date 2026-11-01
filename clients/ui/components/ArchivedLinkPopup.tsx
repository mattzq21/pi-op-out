import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { restoreArchivedConversation } from "../lib/nativeTransport";
import { storageFailureText } from "../lib/storageFailure";

/** An archived chat that a chat link points to. anchor: the clicked link. restorePath: the archive to restore, the chat itself or, for an auxiliary chat, its root. root: the name of that root. */
export type ArchivedLink = { hostId: string; sessionId: string; restorePath: string; name: string; root?: string; anchor: HTMLElement };

const margin = 8;

/** The small popup under a link to an archived chat. It restores the chat, then onRestored opens it. */
export function ArchivedLinkPopup(props: { link: ArchivedLink; onClose: () => void; onRestored: () => void }) {
  const [position, setPosition] = createSignal({ left: 0, top: 0 });
  const [restoring, setRestoring] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let element: HTMLDivElement | undefined;
  let restoreButton: HTMLButtonElement | undefined;

  const close = () => { props.onClose(); if (props.link.anchor.isConnected) props.link.anchor.focus({ preventScroll: true }); };

  const restore = async () => {
    setRestoring(true); setError(undefined);

    try { await restoreArchivedConversation(props.link.restorePath, props.link.hostId); props.onRestored(); }
    catch (reason) { setError(storageFailureText("restore", reason)); }
    finally { setRestoring(false); }
  };

  onMount(() => {
    const anchor = props.link.anchor.getBoundingClientRect();
    const size = element!.getBoundingClientRect();
    const below = anchor.bottom + 6;
    setPosition({
      left: Math.max(margin, Math.min(anchor.left, window.innerWidth - size.width - margin)),
      top: below + size.height + margin <= window.innerHeight ? below : Math.max(margin, anchor.top - size.height - 6),
    });
    restoreButton?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!restoring() && event.target instanceof Node && !element!.contains(event.target)) props.onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !restoring()) { event.preventDefault(); close(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); });
  });

  return <Portal mount={props.link.anchor.closest(".app") ?? document.body}>
    <div ref={element} class="archived-link-popup" role="dialog" aria-label={`${props.link.name} is archived`} style={{ left: `${position().left}px`, top: `${position().top}px` }}>
      <strong>“{props.link.name}” is archived</strong>
      <span>{props.link.root === undefined ? "Restore it to open it." : `It belongs to “${props.link.root}”. Restore that chat to open it.`}</span>
      <Show when={error()}><p role="alert">{error()}</p></Show>
      <div class="archived-link-popup-actions">
        <button type="button" disabled={restoring()} onClick={close}>Cancel</button>
        <button ref={restoreButton} type="button" class="primary-button" disabled={restoring()} onClick={() => void restore()}>{restoring() ? "Restoring…" : "Restore and open"}</button>
      </div>
    </div>
  </Portal>;
}
