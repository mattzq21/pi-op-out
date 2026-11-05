import { createSignal, untrack } from "solid-js";
import { createDependencyEffect, createRef, cssPixels, type JSXElement } from "../lib/solid";
import type { Accessor } from "solid-js";

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

export function DeferredTurn(componentProps: { children: JSXElement; scrollRoot: Accessor<HTMLElement | null | undefined>; eager: boolean; navigationId?: string }) {
  const element = createRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = createSignal(untrack(() => componentProps.eager));
  const [searching, setSearching] = createSignal(false);
  createDependencyEffect(() => {
    const target = element.current;
    const reveal = () => setRevealed(true);
    target?.addEventListener("piop:reveal-turn", reveal);

    return () => target?.removeEventListener("piop:reveal-turn", reveal);
  }, () => []);
  createDependencyEffect(() => {
    const root = componentProps.scrollRoot()?.closest(".chat-shell");

    if (!root) return;
    const find = (event: Event) => setSearching(event instanceof CustomEvent && event.detail === true);
    root.addEventListener("piop:find-open", find);
    setSearching(root.hasAttribute("data-find-open"));

    return () => root.removeEventListener("piop:find-open", find);
  }, () => [componentProps.scrollRoot()]);
  createDependencyEffect(() => { const capturedRevealed = revealed();

    if (capturedRevealed) return;
    const root = componentProps.scrollRoot();
    const target = element.current;

    if (typeof IntersectionObserver === "undefined") { setRevealed(true);

    return; }

    if (!root || !target) return;

    return observeTurn(root, target, () => setRevealed(true));
  }, () => [revealed(), componentProps.scrollRoot()]);

  return <div ref={node => { element.current = node; }} class="deferred-turn" data-response-turn={componentProps.navigationId} style={{ "min-height": cssPixels(revealed() || componentProps.eager || searching() ? undefined : 180) }}>
    {(revealed() || componentProps.eager || searching()) && componentProps.children}
  </div>;
}
