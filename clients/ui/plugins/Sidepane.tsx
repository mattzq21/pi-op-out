import { createPanelSize } from "../lib/panelSize";
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";

export function Sidepane(props: { open: boolean; children: JSX.Element }) {
  const [width, setWidth] = createPanelSize("piop-sidepane-width", 420, 300);
  const [available, setAvailable] = createSignal(window.innerWidth);
  const [dragging, setDragging] = createSignal(false);
  const maximum = () => Math.max(0, Math.floor(available() * .6));
  const minimum = () => Math.min(300, maximum());
  const shownWidth = () => Math.min(maximum(), Math.max(minimum(), width()));
  let pane: HTMLElement | undefined;
  let drag: { x: number; width: number; pointer: number } | undefined;

  const resize = (value: number) => {
    const next = Math.round(Math.min(maximum(), Math.max(minimum(), value)));
    setWidth(next);
  };

  onMount(() => {
    const container = pane?.parentElement;

    if (!container) return;
    const measure = () => setAvailable(container.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(container); measure();
    onCleanup(() => observer.disconnect());
  });

  return <aside ref={pane} id="plugin-sidepane" class="plugin-sidepane" hidden={!props.open} aria-label="Plugins" style={{ "--plugin-width": `${shownWidth()}px` }}>
    <Show when={props.open}><div class="plugin-resizer" classList={{ dragging: dragging() }} role="separator" tabIndex={0} aria-label="Sidepane width" aria-orientation="vertical" aria-valuemin={minimum()} aria-valuemax={maximum()} aria-valuenow={shownWidth()}
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
