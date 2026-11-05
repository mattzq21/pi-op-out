export interface ConversationChild {
  sessionId: string;
  sessionPath: string;
  kind: string;
}

export interface ConversationChildIndex {
  version: 1;
  sessionId: string;
  sessionPath: string;
  complete: boolean;
  children: ConversationChild[];
}

export function initialize(sessionPath: string, sessionId: string, fresh: boolean): void;

export function tree(root: string, sessionId: string): string[];
