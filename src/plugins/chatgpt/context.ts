import type { ChatMessage, ContentPart } from "../../types";
import type { PluginConversation } from "../types";

const marker = "\n\n… Piop conversation truncated …\n\n";

export function boundedChatContext(text: string, limit = 80000) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - marker.length) / 2);

  return text.slice(0, half) + marker + text.slice(-(limit - marker.length - half));
}

function contextPart(part: ContentPart) {
  switch (part.type) {
    case "text": return part.text;
    case "toolCall": return `Tool: ${part.name}\n${boundedChatContext(JSON.stringify(part.arguments), 10000)}`;
    case "image": return "[Attached image]";
    default: return "";
  }
}

function contextMessage(message: ChatMessage) {
  if (message.role === "system") return "";
  const text = Array.isArray(message.content) ? message.content.map(contextPart).filter(Boolean).join("\n") : message.content;

  if (!text) return "";
  const label = message.role === "tool" ? `Tool: ${message.toolName ?? "result"}` : message.role;

  return `## ${label}\n${boundedChatContext(text)}`;
}

export type ChatGptContextSource = PluginConversation;

export function captureChatGptContext(read: () => ChatGptContextSource) {
  const source = read();

  return { ...source, readMessages: () => {
    const current = read();

    return current.hostId === source.hostId && current.sessionId === source.sessionId ? current.messages : source.messages;
  } };
}

function recentItems(messages: ChatMessage[]) {
  const turns: ChatMessage[][] = [];

  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1)?.push(message);
  }

  return turns.slice(-5).flatMap(turn => turn.slice(-100));
}

export async function chatGptContext(source: ChatGptContextSource) {
  const items = recentItems(source.messages);
  const rendered = [];

  for (const item of items) rendered.push(await loadedContextMessage(source, item));
  const omitted = items.length < source.messages.length ? "[Earlier conversation items omitted]" : "";
  let text = boundedChatContext([`# ${source.title}`, omitted, ...rendered].filter(Boolean).join("\n\n"));

  if (source.selected) text += `\n\nThe user is referring to this in particular:\n${boundedChatContext(source.selected.text, 10000)}\n\nPrioritize this source message over the broader conversation context:\n${boundedChatContext(source.selected.source, 34000)}`;

  return text;
}

async function loadedContextMessage(source: ChatGptContextSource, item: ChatMessage) {
  if (!item.loadToolPayload || item.toolPayloadLoaded) return contextMessage(item);

  try {
    await item.loadToolPayload();
    const loaded = source.readMessages?.().find(message => message.id === item.id);

    if (loaded?.toolPayloadLoaded) return contextMessage(loaded);
  } catch { }

  return `## tool\n[Deferred tool output unavailable: ${item.toolName ?? "tool"}]`;
}
