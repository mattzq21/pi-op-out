export function anchorQuestion(dialog: HTMLDialogElement, selector: string) {
  const composer = document.querySelector<HTMLElement>(selector);
  if (!composer) return;
  const position = () => {
    const bounds = composer.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const anchorTop = Math.min(bounds.top - 8, bottom - 12);
    Object.assign(dialog.style, {
      left: `${bounds.left}px`,
      right: "auto",
      bottom: `${window.innerHeight - anchorTop}px`,
      width: `${bounds.width}px`,
      maxWidth: "none",
      maxHeight: `${Math.max(0, anchorTop - top - 12)}px`,
      margin: "0",
    });
  };
  const observer = new ResizeObserver(position);
  for (let element: HTMLElement | null = composer; element; element = element.parentElement) observer.observe(element);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  position();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    window.visualViewport?.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("scroll", position);
  };
}
