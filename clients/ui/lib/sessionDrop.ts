import type { SessionSummary } from "../types";

/** Sent by the sidebar to a chat view under a dragged chat: "over" at each pointer move there, "leave" when it goes away, "drop" when it is released there. x and y are the pointer position in the window. */
export const SESSION_DRAG_EVENT = "piop-session-drag";

export type SessionDragDetail = { phase: "leave" } | { phase: "over"; x: number; y: number } | { phase: "drop"; session: SessionSummary; x: number; y: number };

declare module "solid-js" {
  namespace JSX {
    interface CustomEvents { "piop-session-drag": CustomEvent<SessionDragDetail>; }
  }
}

/** The attribute that marks an element as a place where a chat can be dropped. */
export const SESSION_DROP_ZONE = "data-session-drop-zone";

export function sendSessionDrag(target: HTMLElement, detail: SessionDragDetail) {
  target.dispatchEvent(new CustomEvent<SessionDragDetail>(SESSION_DRAG_EVENT, { detail }));
}

/** A Markdown link to the chat: [name](piop://session/<hostId>/<sessionId>). */
export function sessionLink(session: SessionSummary) {
  const name = (session.name.trim() || "Chat").replace(/[\\[\]]/g, match => "\\" + match);

  return "[" + name + "](piop://session/" + encodeURIComponent(session.hostId ?? "local") + "/" + encodeURIComponent(session.id) + ")";
}

/** The draft with the text added at its end, after a space when the draft does not already end in white space. */
export function appendToDraft(draft: string, text: string) {
  return !draft || /\s$/.test(draft) ? draft + text : draft + " " + text;
}

/** The text to put at `offset` in the draft, with a space before and after it where the draft has no white space. */
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
