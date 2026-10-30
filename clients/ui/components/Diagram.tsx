import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { renderDiagram } from "../lib/diagrams";
import "./diagram.css";
import { copyText } from "../lib/clipboard";

export function Diagram(props: { source: string; complete: boolean }) {
  const [svg, setSvg] = createSignal("");
  const [error, setError] = createSignal("");
  const [sourceVisible, setSourceVisible] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [feedback, setFeedback] = createSignal("");
  let root!: HTMLElement;
  let viewport!: HTMLDivElement;
  let dialog!: HTMLDialogElement;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  let pinch: { distance: number; zoom: number } | undefined;
  onMount(() => {
    root.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("touchstart", touchStart, { passive: false });
    viewport.addEventListener("touchmove", touchMove, { passive: false });
    viewport.addEventListener("touchend", touchEnd);
    viewport.addEventListener("touchcancel", touchEnd);
    onCleanup(() => {
      root.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("touchend", touchEnd);
      viewport.removeEventListener("touchcancel", touchEnd);
    });
  });
  onCleanup(() => { revision++; clearTimeout(timer); });
  createEffect(() => {
    const source = props.source;
    const complete = props.complete;
    const version = ++revision;
    setError("");
    setSvg("");

    if (!complete) return;
    const current = () => revision === version;
    void renderDiagram(source, current).then(result => {
      if (current() && result) setSvg(result);
    }).catch(reason => {
      if (current()) setError(reason instanceof Error ? reason.message : "Could not render this diagram.");
    });
  });

  const notify = (message: string) => {
    clearTimeout(timer); setFeedback(message);
    timer = setTimeout(() => setFeedback(""), 1800);
  };

  const copy = async () => {
    try { await copyText(props.source); notify("Source copied"); }
    catch { notify("Could not copy source"); }
  };

  const open = () => { setZoom(1); dialog.showModal(); viewport?.scrollTo(0, 0); };
  const close = () => dialog.close();
  const reset = () => { setZoom(1); viewport?.scrollTo(0, 0); };

  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey || !event.deltaY || !(event.target instanceof Node) || !viewport?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    setZoom(value => Math.max(0.5, Math.min(4, value - Math.sign(event.deltaY) * 0.25)));
  };

  const span = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    pinch = { distance: span(event.touches), zoom: zoom() };
  };

  const touchMove = (event: TouchEvent) => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const before = zoom();
    const next = Math.max(0.5, Math.min(4, pinch.zoom * span(event.touches) / pinch.distance));
    if (next === before) return;
    const box = viewport.getBoundingClientRect();
    const x = (event.touches[0].clientX + event.touches[1].clientX) / 2 - box.left;
    const y = (event.touches[0].clientY + event.touches[1].clientY) / 2 - box.top;
    const left = viewport.scrollLeft + x;
    const top = viewport.scrollTop + y;
    setZoom(next);
    viewport.scrollLeft = left * next / before - x;
    viewport.scrollTop = top * next / before - y;
  };

  const touchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) pinch = undefined;
  };

  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event: PointerEvent) => {
    if (!drag) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  };

  return <section ref={root} class="diagram" aria-label="Mermaid diagram">
    <div class="diagram-toolbar" role="group" aria-label="Diagram controls">
      <span class="diagram-label">Diagram</span>
      <button type="button" onClick={() => setSourceVisible(!sourceVisible())} aria-pressed={sourceVisible()}>Source</button>
      <button type="button" onClick={() => void copy()}>Copy</button>
      <button type="button" disabled={!svg()} onClick={open}>Expand</button>
    </div>
    <Show when={svg()}>
      <button type="button" class="diagram-thumb" aria-label="Open diagram preview" data-tooltip="Click to open a larger preview" onClick={open}>
        <div class="diagram-thumb-canvas" innerHTML={svg()} />
      </button>
    </Show>
    <Show when={!props.complete}><p class="diagram-status" role="status">Receiving diagram…</p></Show>
    <Show when={props.complete && !svg() && !error()}><p class="diagram-status" role="status">Rendering diagram…</p></Show>
    <Show when={error()}><p class="diagram-error" role="status">Could not render diagram: {error()}</p></Show>
    <Show when={sourceVisible() || error()}><pre class="diagram-source"><code>{props.source}</code></pre></Show>
    <Show when={feedback()}><p class="diagram-status" role="status">{feedback()}</p></Show>
    <dialog ref={dialog} class="diagram-dialog" aria-label="Diagram preview" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog) close(); }}>
      <div class="diagram-toolbar" role="group" aria-label="Diagram controls">
        <span class="diagram-label">Diagram</span>
        <button type="button" aria-label="Zoom out" disabled={zoom() <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom() - 0.25))}>−</button>
        <button type="button" onClick={reset} data-tooltip="Reset zoom and position">{Math.round(zoom() * 100)}%</button>
        <button type="button" aria-label="Zoom in" disabled={zoom() >= 4} onClick={() => setZoom(Math.min(4, zoom() + 0.25))}>+</button>
        <button type="button" onClick={close}>Close</button>
      </div>
      <div ref={viewport} class="diagram-viewport" tabindex="0" role="region" aria-label="Diagram preview; scroll or drag to pan, Ctrl+scroll to zoom" data-tooltip="Ctrl+scroll up to zoom in, Ctrl+scroll down to zoom out" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { drag = undefined; }} onLostPointerCapture={() => { drag = undefined; }}>
        <div class="diagram-canvas" style={{ width: `${zoom() * 100}%` }} innerHTML={svg()} />
      </div>
    </dialog>
  </section>;
}
