import type { ChatMessage } from "../types";
import { textOf } from "./content";

function precedingUser(messages: ChatMessage[]) {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "user") return message;
  }
}

/** The last turn when its response was stopped or failed, with the prompt to send again. */
export function findRetryableTurn(messages: ChatMessage[]) {
  const assistant = messages.at(-1);

  if (assistant?.role !== "assistant" || (assistant.stopReason !== "aborted" && assistant.stopReason !== "error")) return undefined;
  const user = precedingUser(messages);

  const prompt = user ? textOf(user.content).trim() : "";

  return user && prompt ? { assistant, user, prompt } : undefined;
}
