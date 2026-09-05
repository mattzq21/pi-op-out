import type { ChatMessage, ContentPart, PromptContextInfo } from "../types";

const visibleUserContent = (content: unknown) => content;

export type PiEntry = { type: string; id: string; parentId: string | null; message?: Omit<ChatMessage, "id" | "entryId"> & { role: string; timestamp?: number }; customType?: string; content?: ChatMessage["content"]; data?: unknown; display?: boolean; timestamp?: string };

export function resumeMarker(entry: PiEntry) {
  const message = (entry.data as { message?: unknown } | undefined)?.message;
  return entry.type === "custom" && entry.customType === "pi-desktop-resume" && typeof message === "string" ? message : undefined;
}

export function isResumeMessage(message: { role?: unknown; content?: unknown }, markers: ReadonlySet<string>) {
  if (message.role !== "user") return false;
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
  return markers.has(text);
}

export function checkpointLatestUser(messages: ChatMessage[]) {
  const index = messages.map((message) => message.role).lastIndexOf("user");
  if (index < 0 || messages[index].contextCheckpoint) return messages;
  return messages.map((message, candidate) => candidate === index ? { ...message, contextCheckpoint: true } : message);
}

export function cacheHitStats(usage?: { input: number; cacheRead: number }) {
  if (!usage) return undefined;
  const promptTokens = usage.input + usage.cacheRead;
  if (promptTokens <= 0) return undefined;
  return { rate: Math.round(usage.cacheRead / promptTokens * 100), low: usage.cacheRead < Math.max(promptTokens * .5, 1000), cachedTokens: usage.cacheRead, promptTokens };
}

export function normalizeMessage(message: Record<string, unknown>, entryId?: string, completedAt?: string, fallbackId?: string): ChatMessage {
  const numericStamp = Number(message.timestamp || Date.now());
  const stamp = Number.isFinite(numericStamp) ? numericStamp : Date.parse(String(message.timestamp)) || Date.now();
  const completionStamp = completedAt ? Date.parse(completedAt) : NaN;
  const isBtw = message.role === "custom" && message.customType === "pi-desktop-btw";
  return { ...(message as unknown as ChatMessage), ...(message.role === "user" ? { content: visibleUserContent(message.content) as ChatMessage["content"] } : {}), id: entryId || fallbackId || (typeof message.id === "string" ? message.id : undefined) || `live-${message.role}-${stamp}`, entryId, role: (message.role === "toolResult" ? "tool" : isBtw ? "assistant" : message.role) as ChatMessage["role"], toolStatus: message.role === "toolResult" ? (message.isError ? "error" : "done") : undefined, timestamp: stamp, ...(Number.isFinite(completionStamp) ? { completedAt: completionStamp } : {}) };
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
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const branch: PiEntry[] = []; const visited = new Set<string>(); let cursor = leafId;
  while (cursor && !visited.has(cursor)) { visited.add(cursor); const entry = byId.get(cursor); if (!entry) break; branch.unshift(entry); cursor = entry.parentId; }
  let messages: ChatMessage[] = []; const resumeMarkers = new Set<string>(); let promptContext: PromptContextInfo | undefined; let sequenceMarkerAuthorized = false;
  for (const entry of branch) {
    const marker = resumeMarker(entry); if (marker) { resumeMarkers.add(marker); messages = checkpointLatestUser(messages); continue; }
    if (entry.type === "custom" && entry.customType === "pi-desktop-pause-state" && (entry.data as { isPaused?: boolean } | undefined)?.isPaused) messages = checkpointLatestUser(messages);
    if (entry.type === "custom" && entry.customType === "pi-desktop-prompt-context") { promptContext = entry.data as PromptContextInfo; continue; }
    if (entry.type === "custom" && entry.customType === "pi-orchestration-sequence-marker") { sequenceMarkerAuthorized = true; continue; }
    if (entry.type === "message" && entry.message) {
      if (isResumeMessage(entry.message, resumeMarkers)) continue;
      const message = normalizeMessage(entry.message as unknown as Record<string, unknown>, entry.id, entry.timestamp);
      if (!(["user", "assistant", "tool"] as string[]).includes(message.role)) continue;
      const visible = message.role === "user" && sequenceMarkerAuthorized ? { ...message, sequenceMarkerAuthorized: true } : message;
      messages.push(visible.role === "assistant" && promptContext ? { ...visible, promptContext } : visible);
      sequenceMarkerAuthorized = false;
      if (message.role === "assistant") promptContext = undefined;
    }
  }
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
