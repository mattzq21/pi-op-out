import type { ChatMessage } from "../types";
import { textOf } from "./content";
import { isPromptMessage } from "./messages";

export type Usage = NonNullable<ChatMessage["usage"]>;

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

function loadedWork(messages: ChatMessage[], index: number) {
  let start = index;

  while (start > 0 && !isPromptMessage(messages[start - 1])) start--;
  let end = index + 1;

  while (end < messages.length && !isPromptMessage(messages[end])) end++;

  return messages.slice(start, end).filter(message => message === messages[index] || message.role === "assistant" || message.role === "tool" || message.customType === "compaction");
}

export function keepLoadedHistory(cached: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  if (!cached.length) return next;
  const positions = new Map(cached.map((message, index) => [key(message), index]));
  const streamed = (message: ChatMessage) => cached.findIndex(item => !item.entryId && item.role === "assistant" && item.timestamp === message.timestamp && textOf(item.content) === textOf(message.content));
  const loaded = new Map<ChatMessage, ChatMessage[]>();

  for (const message of next) {
    const found = message.deferredWork ? positions.get(key(message)) ?? streamed(message) : undefined;
    const index = found === undefined || found < 0 ? undefined : found;

    if (index !== undefined && !cached[index].deferredWork) loaded.set(message, loadedWork(cached, index));
  }
  const moved = new Set([...loaded.values()].flat().map(key));
  let result = next.flatMap(message => loaded.get(message) ?? (moved.has(key(message)) ? [] : [message]));
  const first = result.find(message => message.id !== OLDER_HISTORY);
  const start = first ? positions.get(key(first)) : undefined;

  if (start !== undefined && start > 0) result = [...cached.slice(0, start), ...result.filter(message => message.id !== OLDER_HISTORY)];

  return result;
}
