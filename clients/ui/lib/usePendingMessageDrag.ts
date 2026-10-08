import { type Accessor, createComputed, createSignal } from "solid-js";
import { createDependencyEffect, createRef, type PointerEvent } from "./solid";

import type { PendingMessage, PendingMessageAction } from "../types";

type Drop = { id: string; targetId?: string; edge?: "before" | "after" };

type Drag = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean; queue: HTMLElement; handle: HTMLButtonElement };

function changesPosition(peers: PendingMessage[], id: string, destination: Drop) {
  const from = peers.findIndex((item) => item.id === id);
  const to = peers.findIndex((item) => item.id === destination.targetId);

  if (from < 0 || to < 0) return false;

  return to + (destination.edge === "after" ? 1 : 0) - (from < to ? 1 : 0) !== from;
}

export function usePendingMessageDrag(messages: Accessor<PendingMessage[]>, disabled: Accessor<boolean>, onMove: Accessor<(id: string, action: PendingMessageAction) => void>) {
  const latest = createRef({ messages: messages(), disabled: disabled(), onMove: onMove() });
  createComputed(() => { latest.current = { messages: messages(), disabled: disabled(), onMove: onMove() }; });
  const active = createRef<Drag | undefined>(undefined);
  const cleanup = createRef<() => void>(() => undefined);
  const [drop, setDrop] = createSignal<Drop>();
  createDependencyEffect(() => () => cleanup.current(), () => []);
  createDependencyEffect(() => {
    const capturedDisabled = disabled(); const capturedMessages = messages();

 if (capturedDisabled || (active.current && !capturedMessages.some((item) => item.id === active.current?.id))) { cleanup.current(); setDrop(undefined); } }, () => [disabled(), messages()]);

  const begin = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || latest.current.disabled) return;
    const source = latest.current.messages.find((item) => item.id === id && !item.retry);
    const queue = event.currentTarget.closest<HTMLElement>(".pending-messages");

    if (!source || !queue) return;
    cleanup.current();
    event.preventDefault(); event.currentTarget.focus();
    const drag: Drag = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, queue, handle: event.currentTarget };
    active.current = drag;

    try { drag.handle.setPointerCapture(event.pointerId); } catch { }

    const target = (): Drop => {
      const bounds = queue.getBoundingClientRect();

      if (drag.x < bounds.left - 64 || drag.x > bounds.right + 64 || drag.y < bounds.top - 40 || drag.y > bounds.bottom + 40) return { id };
      const peers = latest.current.messages.filter((item) => !item.retry && item.behavior === source.behavior && item.id !== id);
      const peerIds = new Set(peers.map(item => item.id));
      const rows = Array.from(queue.querySelectorAll<HTMLElement>("[data-pending-id]")).filter((row) => peerIds.has(row.dataset.pendingId ?? ""));

      const before = rows.find((row) => { const rect = row.getBoundingClientRect();

      return drag.y < rect.top + rect.height / 2; });

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

      if (changesPosition(peers, id, destination)) latest.current.onMove(id, { type: "move", targetId: destination.targetId, edge: destination.edge });
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

  return { get drop() { return drop(); }, get begin() { return begin; } };
}
