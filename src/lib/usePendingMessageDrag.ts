import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PendingMessage, PendingMessageAction } from "../types";

type Drop = { id: string; targetId?: string; edge?: "before" | "after" };
type Drag = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean; queue: HTMLElement; handle: HTMLButtonElement };

export function usePendingMessageDrag(messages: PendingMessage[], disabled: boolean, onMove: (id: string, action: PendingMessageAction) => void) {
  const latest = useRef({ messages, disabled, onMove });
  latest.current = { messages, disabled, onMove };
  const active = useRef<Drag | undefined>(undefined);
  const cleanup = useRef<() => void>(() => undefined);
  const [drop, setDrop] = useState<Drop>();
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => { if (disabled || (active.current && !messages.some((item) => item.id === active.current?.id))) { cleanup.current(); setDrop(undefined); } }, [disabled, messages]);

  const begin = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || latest.current.disabled) return;
    const source = latest.current.messages.find((item) => item.id === id && !item.retry);
    const queue = event.currentTarget.closest<HTMLElement>(".pending-messages");
    if (!source || !queue) return;
    cleanup.current();
    event.preventDefault(); event.currentTarget.focus();
    const drag: Drag = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, queue, handle: event.currentTarget };
    active.current = drag;
    // Window listeners also work in webviews that do not retain pointer capture.
    try { drag.handle.setPointerCapture(event.pointerId); } catch { /* Window listeners remain active. */ }
    const target = (): Drop => {
      const bounds = queue.getBoundingClientRect();
      if (drag.x < bounds.left - 64 || drag.x > bounds.right + 64 || drag.y < bounds.top - 40 || drag.y > bounds.bottom + 40) return { id };
      const peers = latest.current.messages.filter((item) => !item.retry && item.behavior === source.behavior && item.id !== id);
      const rows = Array.from(queue.querySelectorAll<HTMLElement>("[data-pending-id]")).filter((row) => peers.some((item) => item.id === row.dataset.pendingId));
      // A vertical list is ordered by row midpoints, not the exact element under
      // the pointer. This covers icons, gaps, panel padding and horizontal drift.
      const before = rows.find((row) => { const rect = row.getBoundingClientRect(); return drag.y < rect.top + rect.height / 2; });
      const row = before ?? rows.at(-1);
      return { id, targetId: row?.dataset.pendingId, edge: before ? "before" : "after" };
    };
    const showTarget = () => { const next = target(); setDrop((old) => old?.id === next.id && old.targetId === next.targetId && old.edge === next.edge ? old : next); };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== drag.pointerId) return;
      drag.x = pointer.clientX; drag.y = pointer.clientY;
      if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 4) return;
      drag.moved = true; pointer.preventDefault(); showTarget();
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== drag.pointerId) return;
      drag.x = pointer.clientX; drag.y = pointer.clientY;
      const destination = target();
      cleanup.current(); setDrop(undefined);
      if (!drag.moved || latest.current.disabled || !destination.targetId || !destination.edge) return;
      const peers = latest.current.messages.filter((item) => !item.retry && item.behavior === source.behavior);
      const from = peers.findIndex((item) => item.id === id);
      const to = peers.findIndex((item) => item.id === destination.targetId);
      if (from < 0 || to < 0) return;
      const insertion = to + (destination.edge === "after" ? 1 : 0) - (from < to ? 1 : 0);
      if (insertion !== from) latest.current.onMove(id, { type: "move", targetId: destination.targetId, edge: destination.edge });
    };
    const cancel = () => { cleanup.current(); setDrop(undefined); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    let frame = 0;
    const scroll = () => {
      if (drag.moved) {
        const bounds = queue.getBoundingClientRect();
        if (drag.x >= bounds.left - 64 && drag.x <= bounds.right + 64) {
          const delta = drag.y < bounds.top + 24 ? -6 : drag.y > bounds.bottom - 24 ? 6 : 0;
          if (delta) { queue.scrollTop += delta; showTarget(); }
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    frame = requestAnimationFrame(scroll);
    cleanup.current = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key);
      if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
      active.current = undefined; cleanup.current = () => undefined;
    };
  };
  return { drop, begin };
}
