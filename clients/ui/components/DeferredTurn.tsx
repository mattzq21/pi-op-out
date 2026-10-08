import { createSignal } from "solid-js";
import { createDependencyEffect, createRef, cssPixels, type JSXElement, type RefObject } from "../lib/solid";

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

export function DeferredTurn(componentProps: { children: JSXElement; scrollRoot: RefObject<HTMLDivElement | null>; eager: boolean; navigationId?: string }) {
  const element = createRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = createSignal(componentProps.eager);
  const [searching, setSearching] = createSignal(false);
  createDependencyEffect(() => {
    const target = element.current;
    const reveal = () => setRevealed(true);
    target?.addEventListener("piop:reveal-turn", reveal);

    return () => target?.removeEventListener("piop:reveal-turn", reveal);
  }, () => []);
  createDependencyEffect(() => {
    const root = componentProps.scrollRoot.current?.closest(".chat-shell");

    if (!root) return;
    const find = (event: Event) => setSearching(event instanceof CustomEvent && event.detail === true);
    root.addEventListener("piop:find-open", find);
    setSearching(root.hasAttribute("data-find-open"));

    return () => root.removeEventListener("piop:find-open", find);
  }, () => [componentProps.scrollRoot]);
  createDependencyEffect(() => { const capturedRevealed = revealed(); const capturedScrollRoot0 = componentProps.scrollRoot;

    if (capturedRevealed) return;
    const root = capturedScrollRoot0.current;
    const target = element.current;

    if (!root || !target || typeof IntersectionObserver === "undefined") { setRevealed(true);

    return; }

    return observeTurn(root, target, () => setRevealed(true));
  }, () => [revealed(), componentProps.scrollRoot]);

  return <div ref={node => { element.current = node; }} data-response-turn={componentProps.navigationId} style={{ "content-visibility": searching() ? "visible" : "auto", "contain-intrinsic-size": "auto 180px", "min-height": cssPixels(revealed() || componentProps.eager || searching() ? undefined : 180) }}>
    {(revealed() || componentProps.eager || searching()) && componentProps.children}
  </div>;
}
