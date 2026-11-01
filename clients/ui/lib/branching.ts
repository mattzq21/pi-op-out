import type { AgentState, ChatMessage } from "../types";

export function canBranchFrom(message: ChatMessage | undefined) {
  if (message?.role === "system" && message.customType === "compaction") return true;

  return message?.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "aborted") && !message.streaming && !(Array.isArray(message.content) && message.content.some(part => part.type === "toolCall"));
}

export function branchingAvailable(state: AgentState) {
  return state.canFork !== false && Boolean(state.repository);
}

export function branchCwd(...candidates: Array<string | null | undefined>) {
  const cwd = candidates.find((value): value is string => typeof value === "string" && value.length > 0);

  if (!cwd) throw new Error("The new conversation has no worktree folder");

  return cwd;
}
