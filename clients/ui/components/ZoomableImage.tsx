import { required } from "../lib/required";
import { createSignal, Show } from "solid-js";
import { LoaderCircle, X } from "lucide-solid";
import { createDependencyEffect, createRef } from "../lib/solid";
import { imageTouchGestures } from "./imageTouchGestures";
import "./zoomable-image.css";

function ImageViewer(props: { src: string; alt: string; onClose: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const contentRef = createRef<HTMLDivElement>(null);
  const imageRef = createRef<HTMLImageElement>(null);
  const [fullSize, setFullSize] = createSignal(false);
  const [zoom, setZoom] = createSignal<number>();
  const [dragging, setDragging] = createSignal(false);
  const pan = createRef<{ pointerId: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  const suppressClick = createRef(false);
  const expanded = () => fullSize() || zoom() !== undefined;
  const toggleSize = () => { const fit = expanded(); setZoom(undefined); setFullSize(!fit); };

  const startPan = (event: PointerEvent & { currentTarget: HTMLImageElement }) => {
    suppressClick.current = false;
    const content = contentRef.current;

    if (!expanded() || !content || event.button !== 0 || event.pointerType === "touch") return;
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: content.scrollLeft, top: content.scrollTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePan = (event: PointerEvent) => {
    const start = pan.current;
    const content = contentRef.current;

    if (!start || !content || event.pointerId !== start.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (!dragging() && Math.hypot(dx, dy) < 4) return;
    suppressClick.current = true;
    setDragging(true);
    content.scrollLeft = start.left - dx;
    content.scrollTop = start.top - dy;
  };

  const endPan = () => { pan.current = undefined; setDragging(false); };

  const clickImage = (event: MouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation();

    return; }

    if (event.target === imageRef.current || event.detail === 0) { event.stopPropagation(); toggleSize(); }
  };

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
    const factor = Math.exp(Math.max(-0.25, Math.min(0.25, -delta * 0.002)));
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

    const removeTouchGestures = contentRef.current && imageTouchGestures(contentRef.current, {
      image: () => imageRef.current,
      expanded,
      setZoom,
      suppressClick: () => { suppressClick.current = true; },
    });

    return () => { removeTouchGestures?.(); dialog?.removeEventListener("wheel", zoomImage); dialog?.close(); returnFocus?.focus({ preventScroll: true }); };
  }, () => []);

  return <dialog ref={element => { dialogRef.current = element; }} class="image-viewer" aria-label={props.alt} onClick={props.onClose} onCancel={event => { event.preventDefault(); props.onClose(); }} onClose={props.onClose}>
    <div class="image-viewer-toolbar">
      <button type="button" autofocus aria-label="Close image" data-tooltip="Close image"><X size={22} /></button>
    </div>
    <div ref={element => { contentRef.current = element; }} class="image-viewer-content">
      <button type="button" class="image-viewer-image" classList={{ "full-size": expanded(), dragging: dragging() }} aria-label={expanded() ? "Fit image to screen" : "View image at full size"} onClick={clickImage}>
        <img ref={element => { imageRef.current = element; }} src={props.src} alt={props.alt} draggable={false} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan} style={{ width: zoom() !== undefined ? `${required(imageRef.current).naturalWidth * required(zoom())}px` : undefined, height: zoom() !== undefined ? `${required(imageRef.current).naturalHeight * required(zoom())}px` : undefined }} />
      </button>
    </div>
  </dialog>;
}

export function ImageLoading() {
  return <span class="image-loading" role="status"><LoaderCircle size={18} aria-hidden="true" /><span>Loading image…</span></span>;
}

export function ZoomableImage(props: { src: string; alt: string; onError?: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading");

  createDependencyEffect(() => { setState("loading"); setOpen(false); }, () => [props.src]);

  const failed = () => { setState("error"); props.onError?.(); };

  return <>
    <button type="button" class="image-preview" classList={{ loading: state() === "loading" }} disabled={state() !== "ready"} aria-busy={state() === "loading"} aria-label={`${state() === "loading" ? "Loading image" : state() === "error" ? "Image unavailable" : "Enlarge image"}: ${props.alt}`} onClick={() => setOpen(true)}>
      <img src={props.src} alt={props.alt} hidden={state() !== "ready"} onLoad={() => setState("ready")} onError={failed} />
      <Show when={state() === "loading"}><ImageLoading /></Show>
      <Show when={state() === "error"}><span class="image-loading" role="status">Image unavailable</span></Show>
    </button>
    <Show when={open()}><ImageViewer src={props.src} alt={props.alt} onClose={() => setOpen(false)} /></Show>
  </>;
}
