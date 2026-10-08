type TouchPosition = { x: number; y: number; distance: number; count: number };

function position(touches: TouchList): TouchPosition | undefined {
  const first = touches[0];

  if (!first) return undefined;
  const second = touches[1];

  return second ? {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
    count: 2,
  } : { x: first.clientX, y: first.clientY, distance: 0, count: 1 };
}

function pinch(content: HTMLElement, image: HTMLImageElement | null, last: TouchPosition, next: TouchPosition, setZoom: (scale: number) => void) {
  if (!image?.naturalWidth || last.distance <= 0) return;
  const before = image.getBoundingClientRect();
  const x = (last.x - before.left) / before.width;
  const y = (last.y - before.top) / before.height;
  setZoom(Math.max(0.01, Math.min(16, before.width / image.naturalWidth * next.distance / last.distance)));
  const after = image.getBoundingClientRect();
  content.scrollLeft += after.left + x * after.width - next.x;
  content.scrollTop += after.top + y * after.height - next.y;
}

export function imageTouchGestures(content: HTMLElement, options: {
  image: () => HTMLImageElement | null;
  expanded: () => boolean;
  setZoom: (scale: number) => void;
  suppressClick: () => void;
}) {
  let previous: TouchPosition | undefined;

  const start = (event: TouchEvent) => {
    previous = position(event.touches);

    if (event.touches.length > 1) { event.preventDefault(); options.suppressClick(); }
  };

  const move = (event: TouchEvent) => {
    const next = position(event.touches);
    const last = previous;
    previous = next;

    if (!next || !last || next.count !== last.count) return;

    if (next.count === 2) {
      event.preventDefault();
      options.suppressClick();
      pinch(content, options.image(), last, next, options.setZoom);
    } else if (next.count === 1 && options.expanded()) {
      event.preventDefault();

      if (Math.hypot(next.x - last.x, next.y - last.y) < 1) return;
      options.suppressClick();
      content.scrollLeft += last.x - next.x;
      content.scrollTop += last.y - next.y;
    }
  };

  const end = (event: TouchEvent) => { previous = position(event.touches); };

  const cancel = () => { previous = undefined; };

  content.addEventListener("touchstart", start, { passive: false });
  content.addEventListener("touchmove", move, { passive: false });
  content.addEventListener("touchend", end);
  content.addEventListener("touchcancel", cancel);

  return () => {
    content.removeEventListener("touchstart", start);
    content.removeEventListener("touchmove", move);
    content.removeEventListener("touchend", end);
    content.removeEventListener("touchcancel", cancel);
  };
}
