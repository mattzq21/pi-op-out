import type { SessionSummary } from "../types";

export const SESSION_DRAG_EVENT = "piop-session-drag";

export type SessionDragDetail = { phase: "leave" } | { phase: "over"; x: number; y: number } | { phase: "drop"; session: SessionSummary; x: number; y: number };

declare module "solid-js" {
  namespace JSX {
    interface CustomEvents { "piop-session-drag": CustomEvent<SessionDragDetail>; }
  }
}

export const SESSION_DROP_ZONE = "data-session-drop-zone";

export function sendSessionDrag(target: HTMLElement, detail: SessionDragDetail) {
  target.dispatchEvent(new CustomEvent<SessionDragDetail>(SESSION_DRAG_EVENT, { detail }));
}

export function sessionLink(session: SessionSummary) {
  const name = (session.name.trim() || "Chat").replace(/[\\[\]]/g, match => "\\" + match);

  return "[" + name + "](piop://session/" + encodeURIComponent(session.hostId ?? "local") + "/" + encodeURIComponent(session.id) + ")";
}

export function appendToDraft(draft: string, text: string) {
  return !draft || /\s$/.test(draft) ? draft + text : draft + " " + text;
}

export function spacedInsert(draft: string, offset: number, text: string) {
  return (offset > 0 && !/\s/.test(draft[offset - 1]) ? " " : "") + text + (offset < draft.length && !/\s/.test(draft[offset]) ? " " : "");
}


export function sessionReference(value: string) {
  const match = /^piop:\/\/session\/([^/?#]+)\/([^/?#]+)$/.exec(value);
  if (!match) return undefined;
  try {
    return { hostId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}
