export interface ConversationChild {
  sessionId: string;
  sessionPath: string;
  /** "subagent", "review" or a kind that a plugin owns, such as "btw". */
  kind: string;
}

export interface ConversationChildIndex {
  version: 1;
  sessionId: string;
  sessionPath: string;
  complete: boolean;
  children: ConversationChild[];
}

export function initialize(sessionPath: string, sessionId: string, fresh: boolean): Promise<void>;
