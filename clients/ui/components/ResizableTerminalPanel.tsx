import { createPanelSize } from "../lib/panelSize";
import { createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef, type CSSProperties, type JSXElement } from "../lib/solid";

const HEIGHT_KEY = "pi-desktop-terminal-height";

const MIN_HEIGHT = 140;

const maximumHeight = () => Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.75));

export function ResizableTerminalPanel(componentProps: { children: JSXElement }) {
  const [maxHeight, setMaxHeight] = createSignal((maximumHeight)());

  const [height, setHeight] = createPanelSize(HEIGHT_KEY, Math.max(210, Math.min(380, Math.round(window.innerHeight * 0.34))), MIN_HEIGHT);

  const [dragging, setDragging] = createSignal(false);
  const drag = createRef<{ pointerId: number; y: number; height: number } | null>(null);
  const visibleHeight = createMemo(() => (Math.max(MIN_HEIGHT, Math.min(maxHeight(), height()))));
  const resize = (value: number) => setHeight(Math.round(Math.max(MIN_HEIGHT, Math.min(maxHeight(), value))));

  createDependencyEffect(() => {
    const onResize = () => setMaxHeight(maximumHeight());
    window.addEventListener("resize", onResize);

    return () => window.removeEventListener("resize", onResize);
  }, () => []);

  createDependencyEffect(() => { const capturedDragging = dragging();

    if (!capturedDragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, () => [dragging()]);

  return <section class="terminal-shell terminal-shell-resizable" aria-label="Session terminal" style={{ height: `${visibleHeight()}px` } satisfies CSSProperties}>
    {componentProps.children}
    <div
      class={`terminal-panel-resizer ${dragging() ? "dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label="Terminal panel height"
      aria-orientation="horizontal"
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={maxHeight()}
      aria-valuenow={visibleHeight()}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, y: event.clientY, height: visibleHeight() };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) resize(drag.current.height + drag.current.y - event.clientY);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDblClick={() => resize(Math.max(210, Math.min(380, Math.round(window.innerHeight * 0.34))))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 50 : 10;
        const next = event.key === "ArrowDown" ? visibleHeight() - step : event.key === "ArrowUp" ? visibleHeight() + step : event.key === "Home" ? MIN_HEIGHT : event.key === "End" ? maxHeight() : undefined;

        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        resize(next);
      }}
    />
  </section>;
}
