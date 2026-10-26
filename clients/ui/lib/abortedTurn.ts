import type { ChatMessage } from "../types";
import { textOf } from "./content";

function precedingUser(messages: ChatMessage[]) {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "user") return message;
  }
}

export function findReplaceableAbortedTurn(messages: ChatMessage[]) {
  const assistant = messages.at(-1);

  if (assistant?.role !== "assistant" || assistant.stopReason !== "aborted") return undefined;
  const user = precedingUser(messages);

  const prompt = user ? textOf(user.content).trim() : "";

  return user && prompt ? { assistant, user, prompt } : undefined;
}
