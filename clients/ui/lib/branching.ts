import type { AgentState, ChatMessage } from "../types";

/** A response can start a branch only after it finished as a final answer without tool calls. */
export function canBranchFrom(message: ChatMessage | undefined) {
  return message?.role === "assistant" && message.stopReason === "stop" && !message.streaming && !(Array.isArray(message.content) && message.content.some(part => part.type === "toolCall"));
}

/** Branching needs the saved project repository reported by the daemon. */
export function branchingAvailable(state: AgentState) {
  return state.canFork !== false && Boolean(state.repository);
}

/** The branch must run in the worktree folder the daemon created for it. */
export function branchCwd(...candidates: Array<string | null | undefined>) {
  const cwd = candidates.find((value): value is string => typeof value === "string" && value.length > 0);

  if (!cwd) throw new Error("The new conversation has no worktree folder");

  return cwd;
}
