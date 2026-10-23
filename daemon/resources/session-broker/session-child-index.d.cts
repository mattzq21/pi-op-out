export interface ConversationChild {
  sessionId: string;
  sessionPath: string;
  kind: "subagent" | "review";
}

export interface ConversationChildIndex {
  version: 1;
  sessionId: string;
  sessionPath: string;
  complete: boolean;
  children: ConversationChild[];
}

export function initialize(sessionPath: string, sessionId: string, fresh: boolean): Promise<void>;
