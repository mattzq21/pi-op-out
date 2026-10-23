import type { ChatMessage } from "../types";
import { isPromptMessage } from "./messages";

export type Usage = NonNullable<ChatMessage["usage"]>;

/** The id of the marker that stands for the history older than the loaded messages. */
export const OLDER_HISTORY = "piop-older-history";

export type OlderHistory = { before: string; usage?: Usage };

export function olderHistoryMarker(before: string | null | undefined, usage?: Usage): ChatMessage[] {
  return before ? [{ id: OLDER_HISTORY, role: "system", customType: OLDER_HISTORY, content: "", details: { before, usage } satisfies OlderHistory }] : [];
}

export function olderHistory(messages: ChatMessage[]): OlderHistory | undefined {
  const marker = messages[0];

  return marker?.id === OLDER_HISTORY ? marker.details as OlderHistory : undefined;
}

const key = (message: ChatMessage) => message.entryId ?? message.id;

/** The work messages around a loaded final response, up to the prompts of its turn. */
function loadedWork(messages: ChatMessage[], index: number) {
  let start = index;

  while (start > 0 && !isPromptMessage(messages[start - 1])) start--;
  let end = index + 1;

  while (end < messages.length && !isPromptMessage(messages[end])) end++;

  return messages.slice(start, end).filter(message => message === messages[index] || message.role === "assistant" || message.role === "tool");
}

/** Keeps the older history and the turn work that the client already loaded when a newer view of the same chat replaces it. */
export function keepLoadedHistory(cached: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  if (!cached.length) return next;
  const positions = new Map(cached.map((message, index) => [key(message), index]));
  let result = next.flatMap(message => {
    const index = message.deferredWork ? positions.get(key(message)) : undefined;

    return index !== undefined && !cached[index].deferredWork ? loadedWork(cached, index) : [message];
  });
  const first = result.find(message => message.id !== OLDER_HISTORY);
  const start = first ? positions.get(key(first)) : undefined;

  if (start !== undefined && start > 0) result = [...cached.slice(0, start), ...result.filter(message => message.id !== OLDER_HISTORY)];

  return result;
}
