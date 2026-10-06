import { createSignal, onCleanup, Show, type JSX } from "solid-js";

function savedWidth() {
  try {
    const value = Number(localStorage.getItem("piop-sidepane-width") ?? localStorage.getItem("piop-notes:width"));

    if (Number.isFinite(value) && value >= 300) return value;
  } catch {}

  return 420;
}

export function Sidepane(props: { open: boolean; children: JSX.Element }) {
  const [width, setWidth] = createSignal(savedWidth());
  const [viewport, setViewport] = createSignal(window.innerWidth);
  const [dragging, setDragging] = createSignal(false);
  const maximum = () => Math.max(300, Math.floor(viewport() * .6));
  const shownWidth = () => Math.min(maximum(), Math.max(300, width()));
  let drag: { x: number; width: number; pointer: number } | undefined;

  const resize = (value: number) => {
    const next = Math.round(Math.min(maximum(), Math.max(300, value)));
    setWidth(next);

    try { localStorage.setItem("piop-sidepane-width", String(next)); } catch {}
  };

  const viewportChanged = () => setViewport(window.innerWidth);
  window.addEventListener("resize", viewportChanged);
  onCleanup(() => window.removeEventListener("resize", viewportChanged));

  return <aside id="plugin-sidepane" class="plugin-sidepane" hidden={!props.open} aria-label="Plugins" style={{ "--plugin-width": `${shownWidth()}px` }}>
    <Show when={props.open}><div class="plugin-resizer" classList={{ dragging: dragging() }} role="separator" tabIndex={0} aria-label="Sidepane width" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={maximum()} aria-valuenow={shownWidth()}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        drag = { x: event.clientX, width: shownWidth(), pointer: event.pointerId }; setDragging(true);
      }}
      onPointerMove={event => { if (drag?.pointer === event.pointerId) resize(drag.width + drag.x - event.clientX); }}
      onPointerUp={event => { if (drag?.pointer !== event.pointerId) return; drag = undefined; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag = undefined; setDragging(false); }}
      onLostPointerCapture={() => { drag = undefined; setDragging(false); }}
      onDblClick={() => resize(420)}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); resize(shownWidth() + (event.key === "ArrowLeft" ? 20 : -20));
      }} /></Show>
    {props.children}
  </aside>;
}
