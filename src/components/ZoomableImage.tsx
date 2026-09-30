import { createSignal, Show } from "solid-js";
import { X } from "lucide-solid";
import { createDependencyEffect, createRef } from "../lib/solid";
import "./zoomable-image.css";

function ImageViewer(props: { src: string; alt: string; onClose: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const contentRef = createRef<HTMLDivElement>(null);
  const imageRef = createRef<HTMLImageElement>(null);
  const [fullSize, setFullSize] = createSignal(false);
  const [zoom, setZoom] = createSignal<number>();
  const expanded = () => fullSize() || zoom() !== undefined;
  const toggleSize = () => { const fit = expanded(); setZoom(undefined); setFullSize(!fit); };
  const zoomImage = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    const image = imageRef.current;
    const content = contentRef.current;
    if (!image?.naturalWidth || !content || !event.deltaY) return;
    const before = image.getBoundingClientRect();
    const x = (event.clientX - before.left) / before.width;
    const y = (event.clientY - before.top) / before.height;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? content.clientHeight : 1);
    const factor = Math.exp(Math.max(-0.25, Math.min(0.25, delta * 0.002)));
    setZoom(Math.max(0.01, Math.min(16, before.width / image.naturalWidth * factor)));
    const after = image.getBoundingClientRect();
    content.scrollLeft += after.left + x * after.width - event.clientX;
    content.scrollTop += after.top + y * after.height - event.clientY;
  };
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.addEventListener("wheel", zoomImage, { passive: false });
    return () => { dialog?.removeEventListener("wheel", zoomImage); dialog?.close(); returnFocus?.focus({ preventScroll: true }); };
  }, () => []);
  return <dialog ref={element => { dialogRef.current = element; }} class="image-viewer" aria-label={props.alt} onCancel={event => { event.preventDefault(); props.onClose(); }} onClose={props.onClose}>
    <div class="image-viewer-toolbar">
      <span class="image-viewer-zoom-hint">Ctrl + scroll to zoom{zoom() !== undefined ? ` · ${Math.round(zoom()! * 100)}%` : ""}</span>
      <button type="button" autofocus aria-label="Close image" title="Close image" onClick={props.onClose}><X size={22} /></button>
    </div>
    <div ref={element => { contentRef.current = element; }} class="image-viewer-content">
      <button type="button" class="image-viewer-image" classList={{ "full-size": expanded() }} aria-label={expanded() ? "Fit image to screen" : "View image at full size"} onClick={toggleSize}>
        <img ref={element => { imageRef.current = element; }} src={props.src} alt={props.alt} draggable={false} style={{ width: zoom() !== undefined ? `${imageRef.current!.naturalWidth * zoom()!}px` : undefined, height: zoom() !== undefined ? `${imageRef.current!.naturalHeight * zoom()!}px` : undefined }} />
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
