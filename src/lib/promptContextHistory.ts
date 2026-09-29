import type { ChatMessage, PromptContextInfo, RpcEvent } from "../types";

function isContextStatus(event: RpcEvent) {
  return event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-desktop-prompt-context" && typeof event.statusText === "string" && event.statusText.startsWith("json:");
}

export function promptContextHistory() {
  const contexts = new Map<number, PromptContextInfo>();
  const receive = (event: RpcEvent) => {
    if (!isContextStatus(event)) return false;
    try {
      const value = JSON.parse((event.statusText as string).slice(5));
      const entries: PromptContextInfo[] = Array.isArray(value.contexts) ? value.contexts : [value];
      if (Array.isArray(value.contexts)) contexts.clear();
      for (const context of entries) if (typeof context?.userTimestamp === "number") contexts.set(context.userTimestamp, context);
      return true;
    } catch { return false; }
  };
  const apply = (message: ChatMessage): ChatMessage => {
    const context = message.role === "user" && message.timestamp !== undefined ? contexts.get(message.timestamp) : undefined;
    return context ? { ...message, promptContext: context } : message;
  };
  return { receive, apply };
}
