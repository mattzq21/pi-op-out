import type { NativeTransport } from "../lib/nativeTransport";

export type ScrollPlace = { turnId: string; offset: number };

const places = new WeakMap<NativeTransport, ScrollPlace>();

const turnOf = (root: HTMLElement, turnId: string) => root.querySelector<HTMLElement>(`[data-response-turn="${CSS.escape(turnId)}"]`);

export function savePlace(transport: NativeTransport, root: HTMLElement, atLatest: boolean) {
  if (!root.isConnected) return;
  if (atLatest) { places.delete(transport); return; }
  const turns = root.querySelectorAll<HTMLElement>("[data-response-turn]");
  const top = root.getBoundingClientRect().top;
  let low = 0, high = turns.length;

  while (low < high) { const middle = (low + high) >> 1; if (turns[middle].getBoundingClientRect().bottom > top) high = middle; else low = middle + 1; }
  const turn = turns[low] ?? turns[turns.length - 1];
  const turnId = turn?.dataset.responseTurn;

  if (turn && turnId) places.set(transport, { turnId, offset: turn.getBoundingClientRect().top - top });
}

export const savedPlace = (transport: NativeTransport) => places.get(transport);

export function applyPlace(root: HTMLElement, place: ScrollPlace) {
  const turn = turnOf(root, place.turnId);

  if (!turn) return false;
  turn.dispatchEvent(new CustomEvent("piop:reveal-turn"));
  root.scrollTop += turn.getBoundingClientRect().top - root.getBoundingClientRect().top - place.offset;

  return true;
}
