import { createContext } from "solid-js";

export interface SubagentTarget { name: string; sessionId: string; sessionPath: string; hostId: string; }

export const SubagentNavigationContext = createContext<(target: SubagentTarget) => void>();

export interface SessionLinks { name: (hostId: string, sessionId: string) => string | undefined; open: (hostId: string, sessionId: string, anchor: HTMLElement) => void }

export const SessionLinkContext = createContext<SessionLinks>();

export const ConversationHostContext = createContext<() => string>();
