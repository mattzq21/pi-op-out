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
  const input = message.role === "tool" && message.toolInput !== undefined ? `Input:\n${boundedChatContext(JSON.stringify(message.toolInput) ?? "", 10000)}\n\nOutput:\n` : "";

  if (!text && !input) return "";
  const label = message.role === "tool" ? `Tool: ${message.toolName ?? "result"}` : message.role;

  return `## ${label}\n${boundedChatContext(input + text)}`;
}

export interface ChatGptContextSource extends PluginConversation { preparedContext?: string }

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

export async function chatGptContext(source: ChatGptContextSource, signal: AbortSignal) {
  signal.throwIfAborted();

  if (source.preparedContext !== undefined) return source.preparedContext;
  const items = recentItems(source.messages);
  const rendered = [];

  for (const item of items) {
    signal.throwIfAborted();
    rendered.push(await loadedContextMessage(source, item, signal));
  }

  const omitted = items.length < source.messages.length ? "[Earlier conversation items omitted]" : "";
  let text = boundedChatContext([`# ${source.title}`, omitted, ...rendered].filter(Boolean).join("\n\n"));

  if (source.selected) text += `\n\nThe user is referring to this in particular:\n${boundedChatContext(source.selected.text, 10000)}\n\nPrioritize this source message over the broader conversation context:\n${boundedChatContext(source.selected.source, 34000)}`;

  return text;
}

async function loadedContextMessage(source: ChatGptContextSource, item: ChatMessage, signal: AbortSignal) {
  const current = source.readMessages?.().find(message => message.id === item.id) ?? item;

  if (!current.loadToolPayload || freshToolPayload(current)) return contextMessage(current);

  try {
    await abortableContextLoad(current.loadToolPayload(), signal);
    signal.throwIfAborted();
    const loaded = source.readMessages?.().find(message => message.id === item.id);

    if (loaded && freshToolPayload(loaded)) return contextMessage(loaded);
  } catch { signal.throwIfAborted(); }

  return `## tool\n[Deferred tool output unavailable: ${item.toolName ?? "tool"}]`;
}

function freshToolPayload(message: ChatMessage) { return message.toolPayloadLoaded && message.loadedToolPayloadVersion === message.toolPayloadVersion; }

function abortableContextLoad(load: Promise<unknown>, signal: AbortSignal) {
  signal.throwIfAborted();

  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    load.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
