import type { SessionSummary } from "../types";

/** Sent by the sidebar to a chat view under a dragged chat: "enter" and "leave" while it moves, "drop" when it is released there. */
export const SESSION_DRAG_EVENT = "piop-session-drag";

export type SessionDragDetail = { phase: "enter" | "leave" } | { phase: "drop"; session: SessionSummary };

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


export function sessionReference(value: string) {
  const match = /^piop:\/\/session\/([^/?#]+)\/([^/?#]+)$/.exec(value);
  if (!match) return undefined;
  try {
    return { hostId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}
