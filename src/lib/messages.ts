import type { ChatMessage, ContentPart } from "../types";

export type PiEntry = { type: string; id: string; parentId: string | null; message?: Omit<ChatMessage, "id" | "entryId"> & { role: string; timestamp?: number }; customType?: string; content?: ChatMessage["content"]; display?: boolean; timestamp?: string };

export function cacheHitStats(usage?: { input: number; cacheRead: number }) {
  if (!usage) return undefined;
  const promptTokens = usage.input + usage.cacheRead;
  if (promptTokens <= 0) return undefined;
  return { rate: Math.round(usage.cacheRead / promptTokens * 100), low: usage.cacheRead < Math.max(promptTokens * .5, 1000), cachedTokens: usage.cacheRead, promptTokens };
}

export function normalizeMessage(message: Record<string, unknown>, entryId?: string): ChatMessage {
  const numericStamp = Number(message.timestamp || Date.now());
  const stamp = Number.isFinite(numericStamp) ? numericStamp : Date.parse(String(message.timestamp)) || Date.now();
  const isBtw = message.role === "custom" && message.customType === "pi-desktop-btw";
  return { ...(message as unknown as ChatMessage), id: entryId || `live-${message.role}-${stamp}`, entryId, role: (message.role === "toolResult" ? "tool" : isBtw ? "assistant" : message.role) as ChatMessage["role"], toolStatus: message.role === "toolResult" ? (message.isError ? "error" : "done") : undefined, timestamp: stamp };
}

export function applyAssistantMessageEvent(message: ChatMessage, value: unknown): ChatMessage {
  const event = value as { type?: string; contentIndex?: number; delta?: string; content?: string; id?: string; toolName?: string; toolCall?: { id?: string; name?: string; arguments?: unknown } };
  const index = event.contentIndex;
  if (!Number.isInteger(index) || index === undefined || index < 0) return message;
  const content: ContentPart[] = Array.isArray(message.content) ? [...message.content] : message.content ? [{ type: "text", text: message.content }] : [];
  while (content.length <= index) content.push({ type: "text", text: "" });
  const current = content[index];
  const tool = current?.type === "toolCall" ? current : { type: "toolCall" as const, id: event.id || `tool-${index}`, name: event.toolName || "tool", arguments: {}, partialArgs: "" };
  if (event.type === "text_start") content[index] = { type: "text", text: "" };
  if (event.type === "text_delta") content[index] = { type: "text", text: `${current?.type === "text" ? current.text : ""}${event.delta || ""}` };
  if (event.type === "text_end") content[index] = { type: "text", text: event.content || "" };
  if (event.type === "thinking_start") content[index] = { type: "thinking", thinking: "" };
  if (event.type === "thinking_delta") content[index] = { type: "thinking", thinking: `${current?.type === "thinking" ? current.thinking : ""}${event.delta || ""}` };
  if (event.type === "thinking_end") content[index] = { type: "thinking", thinking: event.content || "" };
  if (event.type === "toolcall_start") content[index] = tool;
  if (event.type === "toolcall_delta") content[index] = { ...tool, partialArgs: `${tool.partialArgs || ""}${event.delta || ""}` };
  if (event.type === "toolcall_end" && event.toolCall) content[index] = { type: "toolCall", id: event.toolCall.id || tool.id, name: event.toolCall.name || tool.name, arguments: event.toolCall.arguments && typeof event.toolCall.arguments === "object" ? event.toolCall.arguments as Record<string, unknown> : {} };
  return { ...message, content, streaming: true };
}

export function branchMessages(entries: PiEntry[], leafId: string | null): ChatMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const branch: PiEntry[] = []; let cursor = leafId;
  while (cursor) { const entry = byId.get(cursor); if (!entry) break; branch.unshift(entry); cursor = entry.parentId; }
  const messages = branch.flatMap((entry) => {
    if (entry.type === "message" && entry.message) return [normalizeMessage(entry.message as unknown as Record<string, unknown>, entry.id)];
    if (entry.type === "custom_message" && entry.customType === "pi-desktop-btw" && entry.display !== false) return [normalizeMessage({ role: "custom", customType: entry.customType, content: entry.content ?? "", timestamp: entry.timestamp ?? Date.now() }, entry.id)];
    return [];
  });
  const calledTargets = new Map<string, string>();
  for (const message of messages) if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "call_agent" && typeof part.arguments.target === "string") calledTargets.set(part.id, part.arguments.target);
  }
  return messages.map((message) => {
    const toolCallId = (message as ChatMessage & { toolCallId?: string }).toolCallId;
    const target = message.toolName === "call_agent" && toolCallId ? calledTargets.get(toolCallId) : undefined;
    return target ? { ...message, toolName: `${target} called` } : message;
  });
}
