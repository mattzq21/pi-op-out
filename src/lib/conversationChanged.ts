export class ConversationChangedError extends Error {
  constructor() {
    super("Conversation changed");
    this.name = "ConversationChangedError";
  }
}

export const isConversationChanged = (reason: unknown): boolean => reason instanceof ConversationChangedError;
