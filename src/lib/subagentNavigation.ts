import { createContext } from "solid-js";

export interface SubagentTarget { name: string; sessionId: string; sessionPath: string; hostId: string; }

export const SubagentNavigationContext = createContext<(target: SubagentTarget) => void>();

export const ConversationHostContext = createContext<() => string>();
