import { createPanelSize } from "../lib/panelSize";
import { createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef, type CSSProperties, type JSXElement } from "../lib/solid";

const WIDTH_KEY = "pi-desktop-sidebar-width";

const MIN_WIDTH = 200;

const maximumWidth = () => Math.max(MIN_WIDTH, Math.floor(window.innerWidth / 2));

export function ResizableSidebar(componentProps: { compact: boolean; children: JSXElement }) {
  const [maxWidth, setMaxWidth] = createSignal((maximumWidth)());

  const [width, setWidth] = createPanelSize(WIDTH_KEY, window.innerWidth <= 1050 ? 280 : 320, MIN_WIDTH);

  const [dragging, setDragging] = createSignal(false);
  const drag = createRef<{ pointerId: number; x: number; width: number } | null>(null);
  const visibleWidth = createMemo(() => (Math.max(MIN_WIDTH, Math.min(maxWidth(), width()))));
  const resize = (value: number) => setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth(), value))));

  createDependencyEffect(() => {
    const onResize = () => setMaxWidth(maximumWidth());
    window.addEventListener("resize", onResize);

    return () => window.removeEventListener("resize", onResize);
  }, () => []);

  createDependencyEffect(() => { const capturedDragging = dragging(); const capturedCompact0 = componentProps.compact;

    if (!capturedDragging || capturedCompact0) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, () => [dragging(), componentProps.compact]);

  return <aside class={`icon-rail ${componentProps.compact ? "compact" : ""}`} style={{ "--rail-width": `${visibleWidth()}px` } satisfies CSSProperties}>
    {componentProps.children}
    {!componentProps.compact && <div
      class={`sidebar-resizer ${dragging() ? "dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label="Sidebar width"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth()}
      aria-valuenow={visibleWidth()}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: visibleWidth() };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) resize(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDblClick={(event) => {
        resize(window.innerWidth <= 1050 ? 280 : 320);
        event.currentTarget.blur();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 50 : 10;
        const next = event.key === "ArrowLeft" ? visibleWidth() - step : event.key === "ArrowRight" ? visibleWidth() + step : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth() : undefined;

        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        resize(next);
      }}
    />}
  </aside>;
}
