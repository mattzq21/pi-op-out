import type { ChatMessage } from "../types";
import { textOf } from "./content";

export function findReplaceableAbortedTurn(messages: ChatMessage[]) {
  const assistant = messages.at(-1);
  if (assistant?.role !== "assistant" || assistant.stopReason !== "aborted") return undefined;
  const user = messages.slice(0, -1).reverse().find((message) => message.role === "user");
  const prompt = user ? textOf(user.content).trim() : "";
  return user && prompt ? { assistant, user, prompt } : undefined;
}
