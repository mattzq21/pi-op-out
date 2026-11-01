import { createContext } from "solid-js";

export interface SubagentTarget { name: string; sessionId: string; sessionPath: string; hostId: string; }

export const SubagentNavigationContext = createContext<(target: SubagentTarget) => void>();

/** Names and opens a session by host and session ID. name is undefined when the session is not listed. anchor: the clicked link, where the offer to restore an archived chat shows. */
export interface SessionLinks { name: (hostId: string, sessionId: string) => string | undefined; open: (hostId: string, sessionId: string, anchor: HTMLElement) => void }

export const SessionLinkContext = createContext<SessionLinks>();

export const ConversationHostContext = createContext<() => string>();
