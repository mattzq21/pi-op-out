import { useEffect, useRef } from "react";

const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(onCancel: () => void, key: string) {
  const modal = useRef<HTMLElement>(null);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const element = modal.current; if (!element) return;
    const controls = () => [...element.querySelectorAll<HTMLElement>(focusable)];
    controls()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancel.current(); return; }
      if (event.key !== "Tab") return;
      const items = controls(); if (!items.length) { event.preventDefault(); return; }
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && current <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && current === items.length - 1) { event.preventDefault(); items[0].focus(); }
    };
    element.addEventListener("keydown", handleKey);
    return () => { element.removeEventListener("keydown", handleKey); if (previous?.isConnected) previous.focus(); };
  }, [key]);
  return modal;
}
