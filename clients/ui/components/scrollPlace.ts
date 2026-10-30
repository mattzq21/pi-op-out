import type { NativeTransport } from "../lib/nativeTransport";

/** Where a chat view is scrolled: the first turn on screen and the distance from the top of the view to the top of that turn. */
export type ScrollPlace = { turnId: string; offset: number };

/** The last place of each chat. It goes with the chat's connection. */
const places = new WeakMap<NativeTransport, ScrollPlace>();

const turnOf = (root: HTMLElement, turnId: string) => root.querySelector<HTMLElement>(`[data-response-turn="${CSS.escape(turnId)}"]`);

/** Records the place of the view. A view at the latest message records no place, so it opens at the latest message again. A view without turns keeps the place recorded before. */
export function savePlace(transport: NativeTransport, root: HTMLElement, atLatest: boolean) {
  if (!root.isConnected) return;
  if (atLatest) { places.delete(transport); return; }
  const turns = root.querySelectorAll<HTMLElement>("[data-response-turn]");
  const top = root.getBoundingClientRect().top;
  // The turns are in order, so a binary search finds the first turn whose bottom is below the top of the view.
  let low = 0, high = turns.length;

  while (low < high) { const middle = (low + high) >> 1; if (turns[middle].getBoundingClientRect().bottom > top) high = middle; else low = middle + 1; }
  const turn = turns[low] ?? turns[turns.length - 1];
  const turnId = turn?.dataset.responseTurn;

  if (turn && turnId) places.set(transport, { turnId, offset: turn.getBoundingClientRect().top - top });
}

export const savedPlace = (transport: NativeTransport) => places.get(transport);

/** Scrolls the view to the place. Returns false when the turn is not in the view. */
export function applyPlace(root: HTMLElement, place: ScrollPlace) {
  const turn = turnOf(root, place.turnId);

  if (!turn) return false;
  // A turn off screen is not drawn yet; it must be drawn to have its true height.
  turn.dispatchEvent(new CustomEvent("piop:reveal-turn"));
  root.scrollTop += turn.getBoundingClientRect().top - root.getBoundingClientRect().top - place.offset;

  return true;
}
