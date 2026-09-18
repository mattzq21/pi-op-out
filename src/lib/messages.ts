import type { ChatMessage, ContentPart, FileChangeSnapshot, PromptContextInfo } from "../types";

import { mergeSpokenMessages, parseVoicePrompt, voiceEntry } from "./voiceMessages";

const visibleUserContent = (content: unknown) => content;
const SYSTEM_MESSAGES = new Set(["pi-desktop-mcp-status", "pi-desktop-catch-up"]);

export type PiEntry = { type: string; id: string; parentId: string | null; message?: Omit<ChatMessage, "id" | "entryId"> & { role: string; timestamp?: number }; customType?: string; content?: ChatMessage["content"]; data?: unknown; display?: boolean; timestamp?: string };

export function appendFileChanges(messages: ChatMessage[], entry: PiEntry): ChatMessage[] {
  if (entry.type !== "custom" || entry.customType !== "piop-file-changes") return messages;
  const data = entry.data as Partial<FileChangeSnapshot> | undefined;
  if (!data || typeof data.cwd !== "string" || typeof data.patch !== "string" || !Array.isArray(data.toolCallIds) || !Array.isArray(data.paths)) return messages;
  const ids = new Set(data.toolCallIds);
  let index = messages.length - 1;
  while (index >= 0 && !(messages[index].role === "tool" && ids.has(messages[index].toolCallId ?? messages[index].id))) index--;
  if (index < 0) return messages;
  const toolPaths = Array.isArray(data.toolPaths) ? data.toolPaths.filter((value) => value && typeof value === "object" && typeof value.toolCallId === "string" && typeof value.path === "string" && typeof value.absolutePath === "string" && typeof value.canonicalPath === "string") : [];
  const snapshot: FileChangeSnapshot = { id: entry.id, cwd: data.cwd, patch: data.patch, toolCallIds: data.toolCallIds.filter((id) => typeof id === "string"), toolPaths, paths: data.paths.filter((path) => typeof path === "string"), warnings: Array.isArray(data.warnings) ? data.warnings.filter((value) => typeof value === "string") : [] };
  return messages.map((message, candidate) => candidate === index ? { ...message, fileChanges: [...(message.fileChanges ?? []).filter((change) => change.id !== entry.id), snapshot] } : message);
}

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

export function cacheHitStats(usage?: { input: number; cacheRead: number; cacheWrite?: number }) {
  if (!usage) return undefined;
  const input = Number(usage.input);
  const cacheRead = Number(usage.cacheRead);
  const cacheWrite = Number(usage.cacheWrite ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(cacheRead) || !Number.isFinite(cacheWrite)) return undefined;
  const promptTokens = input + cacheRead + cacheWrite;
  if (!(promptTokens > 0) || !Number.isFinite(promptTokens)) return undefined;
  if (cacheRead < 0 || cacheRead > promptTokens) return undefined;
  return { rate: Math.round(cacheRead / promptTokens * 100), low: cacheRead < Math.max(promptTokens * .5, 1000), cachedTokens: cacheRead, promptTokens };
}

export function normalizeMessage(message: Record<string, unknown> | null | undefined, entryId?: string, completedAt?: string, fallbackId?: string): ChatMessage {
  const source = (message && typeof message === "object" ? message : {}) as Record<string, unknown>;
  const numericStamp = Number((source as { timestamp?: unknown }).timestamp || Date.now());
  const stamp = Number.isFinite(numericStamp) ? numericStamp : Date.parse(String((source as { timestamp?: unknown }).timestamp)) || Date.now();
  const completionStamp = completedAt ? Date.parse(completedAt) : NaN;
  const isBtw = source.role === "custom" && source.customType === "pi-desktop-btw";
  const isSystemMessage = source.role === "custom" && SYSTEM_MESSAGES.has(String(source.customType));
  return { ...(source as unknown as ChatMessage), ...(source.role === "user" ? { content: visibleUserContent(source.content) as ChatMessage["content"] } : {}), id: entryId || fallbackId || (typeof source.id === "string" ? source.id : undefined) || `live-${String((source as { role?: unknown }).role ?? "message")}-${stamp}`, entryId, role: (source.role === "toolResult" ? "tool" : isBtw ? "assistant" : isSystemMessage ? "system" : source.role) as ChatMessage["role"], toolStatus: source.role === "toolResult" ? ((source as { isError?: unknown }).isError ? "error" : "done") : undefined, timestamp: stamp, ...(Number.isFinite(completionStamp) ? { completedAt: completionStamp } : {}), ...parseVoicePrompt(source) };
}

const MAX_CONTENT_INDEX_GAP = 8;
const MAX_CONTENT_PARTS = 64;

export function applyAssistantMessageEvent(message: ChatMessage, value: unknown): ChatMessage {
  const event = value as { type?: string; contentIndex?: number; delta?: string; content?: string; id?: string; toolName?: string; toolCall?: { id?: string; name?: string; arguments?: unknown } };
  const index = event.contentIndex;
  if (!Number.isInteger(index) || index === undefined || index < 0) return message;
  const content: ContentPart[] = Array.isArray(message.content) ? [...message.content] : message.content ? [{ type: "text", text: message.content }] : [];
  if (index > content.length + MAX_CONTENT_INDEX_GAP) return message;
  if (index >= MAX_CONTENT_PARTS) return message;
  while (content.length <= index) {
    if (content.length >= MAX_CONTENT_PARTS) return message;
    content.push({ type: "text", text: "" });
  }
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
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map<string, PiEntry>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || typeof (entry as PiEntry).id !== "string") continue;
    if (!byId.has((entry as PiEntry).id)) byId.set((entry as PiEntry).id, entry as PiEntry);
  }
  const branch: PiEntry[] = []; const visited = new Set<string>(); let cursor = leafId;
  while (cursor && !visited.has(cursor)) { visited.add(cursor); const entry = byId.get(cursor); if (!entry) break; branch.unshift(entry); cursor = entry.parentId; }
  let messages: ChatMessage[] = []; const resumeMarkers = new Set<string>();
  const spoken: ChatMessage[] = [];
  for (const entry of branch) {
    const voice = voiceEntry(entry); if (voice) { spoken.push(voice); continue; }
    if (entry.type === "custom" && entry.customType === "piop-file-changes") { messages = appendFileChanges(messages, entry); continue; }
    const marker = resumeMarker(entry); if (marker) { resumeMarkers.add(marker); messages = checkpointLatestUser(messages); continue; }
    if (entry.type === "custom" && entry.customType === "pi-desktop-pause-state" && (entry.data as { isPaused?: boolean } | undefined)?.isPaused) messages = checkpointLatestUser(messages);
    if (entry.type === "custom" && entry.customType === "pi-desktop-prompt-context") {
      const userIndex = messages.map((message) => message.role).lastIndexOf("user");
      if (userIndex >= 0 && !messages[userIndex].promptContext) messages[userIndex] = { ...messages[userIndex], promptContext: entry.data as PromptContextInfo };
      continue;
    }
    if (entry.type === "custom_message" && entry.customType !== "pi-desktop-btw" && entry.display !== false) {
      messages.push(normalizeMessage({ role: "custom", customType: entry.customType, content: entry.content ?? "", timestamp: entry.timestamp }, entry.id, entry.timestamp));
      continue;
    }
    if (entry.type === "message" && entry.message) {
      if (isResumeMessage(entry.message, resumeMarkers)) continue;
      const message = normalizeMessage(entry.message as unknown as Record<string, unknown>, entry.id, entry.timestamp);
      if (!(["user", "assistant", "tool"] as string[]).includes(message.role)) continue;
      messages.push(message);
    }
  }
  messages = mergeSpokenMessages(messages, spoken);
  const toolInputs = new Map<string, unknown>();
  for (const message of messages) if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === "toolCall") toolInputs.set(part.id, part.arguments);
  }
  return messages.map((message) => {
    const toolCallId = (message as ChatMessage & { toolCallId?: string }).toolCallId;
    return message.role === "tool" && toolCallId && toolInputs.has(toolCallId) ? { ...message, toolInput: toolInputs.get(toolCallId) } : message;
  });
}
