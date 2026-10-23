function tooltipAnchor(target: EventTarget | null) {
  return target instanceof Element ? target.closest("[data-tooltip]") : null;
}

function positionTooltip(anchor: Element, tooltip: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left + (rect.width - bounds.width) / 2, window.innerWidth - bounds.width - 8));
  const preferredTop = rect.top >= bounds.height + 14 ? rect.top - bounds.height - 6 : rect.bottom + 6;
  const top = Math.max(8, Math.min(preferredTop, window.innerHeight - bounds.height - 8));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function removeTooltipDescription(anchor: Element, id: string) {
  const description = (anchor.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(value => value && value !== id).join(" ");

  if (description) anchor.setAttribute("aria-describedby", description);
  else anchor.removeAttribute("aria-describedby");
}

export function installTooltips() {
  const controller = new AbortController();
  const signal = controller.signal;
  let anchor: Element | null = null;
  let tooltip: HTMLSpanElement | undefined;
  let frame = 0;

  const observer = new MutationObserver(records => {
    if (!anchor?.isConnected) close();
    else if (records.some(record => record.target === anchor)) update();
  });

  function close() {
    observer.disconnect();
    cancelAnimationFrame(frame);

    if (anchor && tooltip) removeTooltipDescription(anchor, tooltip.id);
    tooltip?.remove();
    anchor = null;
    tooltip = undefined;
  }

  function update() {
    if (!anchor || !tooltip) return;
    const text = anchor.getAttribute("data-tooltip");

    if (!text?.trim()) return close();

    if (tooltip.textContent !== text) tooltip.textContent = text;
    positionTooltip(anchor, tooltip);
  }

  function show(target: EventTarget | null) {
    const next = tooltipAnchor(target);

    if (next === anchor) return update();
    close();

    if (!next?.getAttribute("data-tooltip")?.trim()) return;
    anchor = next;
    tooltip = document.createElement("span");
    tooltip.id = "piop-hover-tooltip";
    tooltip.className = "app-tooltip";
    tooltip.setAttribute("role", "tooltip");
    (anchor.closest("dialog[open]") ?? document.body).append(tooltip);
    const description = anchor.getAttribute("aria-describedby");
    anchor.setAttribute("aria-describedby", description ? `${description} ${tooltip.id}` : tooltip.id);
    update();
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tooltip"] });
    frame = requestAnimationFrame(() => tooltip?.classList.add("visible"));
  }

  const pointerOver = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && event.buttons === 0) show(event.target);
  };

  const pointerOut = (event: PointerEvent) => {
    if (!(event.relatedTarget instanceof Node) || !anchor?.contains(event.relatedTarget)) close();
  };

  const focusIn = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches(":focus-visible")) show(event.target);
  };

  const focusOut = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !anchor?.contains(event.relatedTarget)) close();
  };

  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };

  document.addEventListener("pointerover", pointerOver, { capture: true, signal });
  document.addEventListener("pointerout", pointerOut, { capture: true, signal });
  document.addEventListener("focusin", focusIn, { capture: true, signal });
  document.addEventListener("focusout", focusOut, { capture: true, signal });
  document.addEventListener("pointerdown", close, { capture: true, signal });
  document.addEventListener("click", close, { signal });
  document.addEventListener("keydown", keyDown, { capture: true, signal });
  document.addEventListener("close", close, { capture: true, signal });
  window.addEventListener("scroll", close, { capture: true, signal });
  window.addEventListener("resize", close, { signal });
  window.addEventListener("blur", close, { signal });

  return () => { controller.abort(); close(); };
}
