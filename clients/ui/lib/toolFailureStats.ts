import type { ChatMessage } from "../types";

function isCompletedTool(message: ChatMessage) {
  return message.role === "tool" && !message.customType && (message.toolStatus === "done" || message.toolStatus === "error");
}

export function toolFailureStats(messages: ChatMessage[]) {
  const completed = new Map<string, ChatMessage>();

  for (const message of messages) {
    if (!isCompletedTool(message)) continue;
    completed.set(message.toolCallId ?? message.id, message);
  }

  const total = completed.size;

  let failed = 0, invalidUse = 0;

  for (const message of completed.values()) {
    if (message.toolStatus !== "error") continue;
    failed++;

    if (message.toolFailureKind === "invalid-use") invalidUse++;
  }

  return { total, failed, invalidUse, other: failed - invalidUse, rate: total ? Math.round(failed / total * 100) : 0 };
}

export type ToolFailureStats = NonNullable<ReturnType<typeof toolFailureStats>>;
