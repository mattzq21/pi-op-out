import { createSignal, Show } from "solid-js";
import { X } from "lucide-solid";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./zoomable-image.css";

function ImageViewer(props: { src: string; alt: string; onClose: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const [fullSize, setFullSize] = createSignal(false);
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); returnFocus?.focus({ preventScroll: true }); };
  }, () => []);
  return <dialog ref={element => { dialogRef.current = element; }} class="image-viewer" aria-label={props.alt} onCancel={event => { event.preventDefault(); props.onClose(); }} onClose={props.onClose}>
    <div class="image-viewer-toolbar">
      <button type="button" aria-pressed={fullSize()} onClick={() => setFullSize(value => !value)}>{fullSize() ? "Fit to screen" : "Full size"}</button>
      <button type="button" autofocus aria-label="Close image" title="Close image" onClick={props.onClose}><X size={22} /></button>
    </div>
    <div class="image-viewer-content">
      <button type="button" class="image-viewer-image" classList={{ "full-size": fullSize() }} aria-label={fullSize() ? "Fit image to screen" : "View image at full size"} onClick={() => setFullSize(value => !value)}>
        <img src={props.src} alt={props.alt} draggable={false} />
      </button>
    </div>
  </dialog>;
}

export function ZoomableImage(props: { src: string; alt: string }) {
  const [open, setOpen] = createSignal(false);
  return <>
    <button type="button" class="image-preview" aria-label={`Enlarge image: ${props.alt}`} title="Click to enlarge" onClick={() => setOpen(true)}>
      <img src={props.src} alt={props.alt} />
    </button>
    <Show when={open()}><ImageViewer src={props.src} alt={props.alt} onClose={() => setOpen(false)} /></Show>
  </>;
}
