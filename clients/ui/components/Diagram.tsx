import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { renderDiagram } from "../lib/diagrams";
import "./diagram.css";
import { copyText } from "../lib/clipboard";

export function Diagram(props: { source: string; complete: boolean }) {
  const [svg, setSvg] = createSignal("");
  const [error, setError] = createSignal("");
  const [sourceVisible, setSourceVisible] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [expanded, setExpanded] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  let root!: HTMLElement;
  let viewport!: HTMLDivElement;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  onMount(() => {
    root.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => root.removeEventListener("wheel", wheel));
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

  const reset = () => { setZoom(1); viewport?.scrollTo(0, 0); };

  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey || !event.deltaY || !(event.target instanceof Node) || !viewport?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    setZoom(value => Math.max(0.5, Math.min(4, value - Math.sign(event.deltaY) * 0.25)));
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

  return <section ref={root} class="diagram" classList={{ "diagram-expanded": expanded() }} aria-label="Mermaid diagram">
    <div class="diagram-toolbar" role="group" aria-label="Diagram controls">
      <span class="diagram-label">Diagram</span>
      <button type="button" onClick={() => setSourceVisible(!sourceVisible())} aria-pressed={sourceVisible()}>Source</button>
      <button type="button" onClick={() => void copy()}>Copy</button>
      <button type="button" aria-label="Zoom out" disabled={zoom() <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom() - 0.25))}>−</button>
      <button type="button" onClick={reset} data-tooltip="Reset zoom and position">{Math.round(zoom() * 100)}%</button>
      <button type="button" aria-label="Zoom in" disabled={zoom() >= 4} onClick={() => setZoom(Math.min(4, zoom() + 0.25))}>+</button>
      <button type="button" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>{expanded() ? "Collapse" : "Expand"}</button>
    </div>
    <Show when={svg()}>
      <div ref={viewport} class="diagram-viewport" tabindex="0" role="region" aria-label="Diagram preview; scroll or drag to pan, Ctrl+scroll to zoom" data-tooltip="Ctrl+scroll up to zoom in, Ctrl+scroll down to zoom out" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { drag = undefined; }} onLostPointerCapture={() => { drag = undefined; }}>
        <div class="diagram-canvas" style={{ width: `${zoom() * 100}%` }} innerHTML={svg()} />
      </div>
    </Show>
    <Show when={!props.complete}><p class="diagram-status" role="status">Receiving diagram…</p></Show>
    <Show when={props.complete && !svg() && !error()}><p class="diagram-status" role="status">Rendering diagram…</p></Show>
    <Show when={error()}><p class="diagram-error" role="status">Could not render diagram: {error()}</p></Show>
    <Show when={sourceVisible() || error()}><pre class="diagram-source"><code>{props.source}</code></pre></Show>
    <Show when={feedback()}><p class="diagram-status" role="status">{feedback()}</p></Show>
  </section>;
}
