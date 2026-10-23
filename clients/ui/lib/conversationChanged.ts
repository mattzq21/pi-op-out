export class ConversationChangedError extends Error {
  constructor() {
    super("Conversation changed");
    this.name = "ConversationChangedError";
  }
}

export const isConversationChanged = (cause: unknown): boolean => cause instanceof ConversationChangedError;
