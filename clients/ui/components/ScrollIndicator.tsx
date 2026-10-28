import { createDependencyEffect, createRef, type RefObject } from "../lib/solid";

/** A thin bar that shows the scroll position of the messages. It does not take touches or clicks. */
export function ScrollIndicator(props: { scrollRoot: RefObject<HTMLDivElement | null> }) {
  const track = createRef<HTMLDivElement | null>(null);
  const thumb = createRef<HTMLDivElement | null>(null);

  createDependencyEffect(() => {
    const root = props.scrollRoot.current; const bar = track.current; const handle = thumb.current;

    if (!root || !bar || !handle) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const { scrollTop, scrollHeight, clientHeight } = root;

      if (scrollHeight <= clientHeight + 1) { bar.hidden = true; return; }
      bar.hidden = false;
      const length = bar.clientHeight;
      const size = Math.max(24, length * clientHeight / scrollHeight);
      const offset = (length - size) * scrollTop / (scrollHeight - clientHeight);
      handle.style.height = `${size}px`;
      handle.style.transform = `translateY(${offset}px)`;
    };
    const schedule = () => { frame ??= requestAnimationFrame(update); };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    const conversation = root.querySelector(".conversation");

    if (conversation) observer.observe(conversation);

    return () => {
      root.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, () => []);

  return <div ref={element => { track.current = element; }} class="scroll-indicator" aria-hidden="true" hidden><div ref={element => { thumb.current = element; }} /></div>;
}
