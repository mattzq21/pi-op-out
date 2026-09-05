import type { ChatMessage } from "../types";
import { textOf } from "./content";

export function findReplaceableAbortedTurn(messages: ChatMessage[]) {
  const assistant = messages.at(-1);
  if (assistant?.role !== "assistant" || assistant.stopReason !== "aborted" || assistant.errorMessage === "Response paused") return undefined;
  let userIndex = -1;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") { userIndex = index; break; }
    if (message.role === "assistant" && message.errorMessage === "Response paused") return undefined;
  }
  const user = userIndex >= 0 ? messages[userIndex] : undefined;
  if (user?.contextCheckpoint) return undefined;
  const prompt = user ? textOf(user.content).trim() : "";
  return user && prompt ? { assistant, user, prompt } : undefined;
}
