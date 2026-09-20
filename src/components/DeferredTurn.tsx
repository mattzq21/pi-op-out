import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

type ViewportObserver = { observer: IntersectionObserver; callbacks: Map<Element, () => void> };
const observers = new WeakMap<Element, ViewportObserver>();

function observeTurn(root: Element, element: Element, reveal: () => void) {
  let viewport = observers.get(root);
  if (!viewport) {
    const callbacks = new Map<Element, () => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) callbacks.get(entry.target)?.();
    }, { root, rootMargin: "800px 0px" });
    viewport = { observer, callbacks };
    observers.set(root, viewport);
  }
  const current = viewport;
  current.callbacks.set(element, reveal);
  current.observer.observe(element);
  return () => {
    current.observer.unobserve(element);
    current.callbacks.delete(element);
    if (!current.callbacks.size) { current.observer.disconnect(); observers.delete(root); }
  };
}

// History stays in the session cache. Only Markdown/React rendering waits for
// the viewport. Keep visited turns mounted to preserve expanded work and tools.
export function DeferredTurn({ children, scrollRoot, eager }: { children: ReactNode; scrollRoot: RefObject<HTMLDivElement | null>; eager: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(eager);
  useEffect(() => {
    if (revealed) return;
    const root = scrollRoot.current;
    const target = element.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") { setRevealed(true); return; }
    return observeTurn(root, target, () => setRevealed(true));
  }, [revealed, scrollRoot]);
  return <div ref={element} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px", minHeight: revealed || eager ? undefined : 180 }}>
    {(revealed || eager) && children}
  </div>;
}
