/** The element whose scrollbar is under the mouse event, or undefined when the event is on content. */
function scrollbarOwner(event: MouseEvent) {
  const element = event.target;

  if (!(element instanceof HTMLElement)) return undefined;
  const box = element.getBoundingClientRect();
  const x = event.clientX - box.left - element.clientLeft, y = event.clientY - box.top - element.clientTop;
  const vertical = element.offsetWidth - element.clientWidth - element.clientLeft * 2 > 0 && (x < 0 || x >= element.clientWidth);
  const horizontal = element.offsetHeight - element.clientHeight - element.clientTop * 2 > 0 && y >= element.clientHeight;

  return vertical || horizontal ? element : undefined;
}

/**
 * WebKitGTK forgets a dragged scrollbar when another mouse button is pressed during the drag. The release then does not reach the scrollbar,
 * so its thumb follows the pointer over it until the next click on it. A new scrollbar has no drag, so the scrollbar is made again.
 */
export function installScrollbarRelease() {
  let dragged: HTMLElement | undefined;

  const mouseDown = (event: MouseEvent) => {
    if (event.button === 0) { dragged = scrollbarOwner(event); return; }
    if (!dragged || !(event.buttons & 1)) return;
    const element = dragged, style = element.style;
    dragged = undefined;
    const overflow = style.getPropertyValue("overflow"), priority = style.getPropertyPriority("overflow");
    style.setProperty("overflow", "hidden", "important");
    void element.offsetWidth;
    if (overflow) style.setProperty("overflow", overflow, priority);
    else style.removeProperty("overflow");
  };
  const mouseUp = (event: MouseEvent) => { if (!(event.buttons & 1)) dragged = undefined; };

  document.addEventListener("mousedown", mouseDown, true);
  document.addEventListener("mouseup", mouseUp, true);

  return () => { document.removeEventListener("mousedown", mouseDown, true); document.removeEventListener("mouseup", mouseUp, true); };
}
