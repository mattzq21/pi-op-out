import type { ChatMessage } from "../types";
import { pluginMessageMetadata } from "../plugins/messageMetadata";
import { z } from "zod";
import { pauseStateSchema, promptContextSchema, resumeContentSchema, resumeMarkerSchema, wireMessageSchema, type WireMessage } from "./messageSchemas";

const SYSTEM_MESSAGES = new Set(["pi-desktop-mcp-status"]);

export function isContextInjection(message: { role?: string; customType?: string }) {
  return message.role === "custom" && (pluginMessageMetadata(message.customType)?.contextInjection ?? (!SYSTEM_MESSAGES.has(message.customType ?? "") && !["piop-subagent-result", "piop-session-operation", "piop-agent-message"].includes(message.customType ?? "")));
}

export type PiEntry = { type: string; id: string; parentId: string | null; message?: Partial<WireMessage>; customType?: string; details?: unknown; content?: ChatMessage["content"]; data?: unknown; display?: boolean; timestamp?: string; tokensBefore?: number };

const entryIdentitySchema = z.object({ id: z.string() });

function replaceMessage(messages: ChatMessage[], index: number, message: ChatMessage, inPlace: boolean) {
  const result = inPlace ? messages : messages.slice();
  result[index] = message;

  return result;
}

export function resumeMarker(entry: PiEntry) {
  if (entry.type !== "custom" || entry.customType !== "pi-desktop-resume") return undefined;
  const marker = resumeMarkerSchema.safeParse(entry.data);

  return marker.success ? marker.data.message : undefined;
}

export function isResumeMessage(message: { role?: unknown; content?: unknown }, markers: ReadonlySet<string>) {
  if (message.role !== "user") return false;
  const text = resumeContentSchema.parse(message.content);

  return markers.has(text);
}

/** A message that starts a turn: one the user sent, or a message or subagent result from another agent session. */
export const isPromptMessage = (message: ChatMessage) => message.role === "user" || (message.role === "custom" && (message.customType === "piop-agent-message" || message.customType === "piop-subagent-result"));

/** Whether a prompt context snapshot belongs to this message. */
export const promptContextAnchors = (message: ChatMessage, context: { userTimestamp?: number; agentNotificationId?: string }) => message.role === "user"
  ? context.userTimestamp !== undefined && message.timestamp === context.userTimestamp
  : context.agentNotificationId !== undefined && isPromptMessage(message) && (message.details as { notificationId?: unknown } | undefined)?.notificationId === context.agentNotificationId;

function latestUser(messages: ChatMessage[]) {
  let index = messages.length - 1;

  while (index >= 0 && !isPromptMessage(messages[index])) index--;

  return index;
}

export function checkpointLatestUser(messages: ChatMessage[], inPlace = false) {
  const index = latestUser(messages);

  if (index < 0 || messages[index].contextCheckpoint) return messages;

  return replaceMessage(messages, index, { ...messages[index], contextCheckpoint: true }, inPlace);
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

function messageTimestamp(source: WireMessage) {
  const numericStamp = Number(source.timestamp || Date.now());

  return Number.isFinite(numericStamp) ? numericStamp : Date.parse(String(source.timestamp)) || Date.now();
}

function messageRole(source: WireMessage): ChatMessage['role'] {
  const customRole = pluginMessageMetadata(source.customType)?.customRole;

  if (source.role === "custom" && customRole) return customRole;
  const isSystemMessage = source.role === "custom" && SYSTEM_MESSAGES.has(String(source.customType));

  return source.role === 'toolResult' ? 'tool' : isSystemMessage ? 'system' : source.role ?? 'system';
}

function messageIdentity(source: WireMessage, stamp: number, entryId?: string, fallbackId?: string) {
  return entryId || fallbackId || source.id || `live-${source.role ?? 'message'}-${stamp}`;
}

export function normalizeMessage(message: Partial<WireMessage> | null | undefined, entryId?: string, completedAt?: string, fallbackId?: string): ChatMessage {
  const source = wireMessageSchema.parse(message ?? {});
  const stamp = messageTimestamp(source);
  const completionStamp = completedAt ? Date.parse(completedAt) : NaN;

  const normalized: ChatMessage = { ...source, id: messageIdentity(source, stamp, entryId, fallbackId), entryId, role: messageRole(source), toolStatus: source.role === "toolResult" ? (source.isError ? "error" : "done") : undefined, timestamp: stamp };

  const metadata = pluginMessageMetadata(source.customType);

  if (metadata?.toolName !== undefined) normalized.toolName = metadata.toolName;

  if (metadata?.toolStatus !== undefined) normalized.toolStatus = metadata.toolStatus;

  if (Number.isFinite(completionStamp)) normalized.completedAt = completionStamp;

  return normalized;
}

export { applyAssistantMessageEvent } from "./messageEvents";

function entryBranch(entries: PiEntry[], leafId: string | null): PiEntry[] {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map<string, PiEntry>();

  for (const entry of list) {
    if (!entryIdentitySchema.safeParse(entry).success) continue;

    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const branch: PiEntry[] = []; const visited = new Set<string>(); let cursor = leafId;

  while (cursor && !visited.has(cursor)) { visited.add(cursor); const entry = byId.get(cursor);

  if (!entry) break; branch.push(entry); cursor = entry.parentId; }

  return branch.reverse();
}

type SavedPromptParts = { systemPrompt?: unknown; tools?: unknown };

const savedPromptContextSchema = z.looseObject({
  systemPrompt: z.unknown().optional(), tools: z.unknown().optional(),
  sameAsPrevious: z.object({ systemPrompt: z.boolean().optional(), tools: z.boolean().optional() }).optional(),
});

/** Saved snapshots omit the system prompt and tools when they match the previous snapshot on the branch. */
function appendPromptContext(messages: ChatMessage[], entry: PiEntry, previous: SavedPromptParts) {
  const saved = savedPromptContextSchema.safeParse(entry.data);

  if (!saved.success) return;
  const { sameAsPrevious, ...data } = saved.data;

  if (sameAsPrevious?.systemPrompt) data.systemPrompt = previous.systemPrompt; else previous.systemPrompt = data.systemPrompt;

  if (sameAsPrevious?.tools) data.tools = previous.tools; else previous.tools = data.tools;
  const userIndex = latestUser(messages);

  if (userIndex < 0 || messages[userIndex].promptContext) return;
  const context = promptContextSchema.safeParse(data);

  if (context.success) messages[userIndex] = { ...messages[userIndex], promptContext: context.data };
}

export function appendQueuedProjectContext(messages: ChatMessage[], entry: PiEntry, inPlace = false): ChatMessage[] {
  if (entry.type !== "custom" || entry.customType !== "piop-queued-project-context" || messages.some(message => message.id === entry.id)) return messages;
  const context = z.object({ timestamp: z.number(), content: z.string() }).safeParse(entry.data);

  if (!context.success) return messages;
  const result = inPlace ? messages : messages.slice();
  result.push({ ...normalizeMessage({ role: "custom", customType: "pi-project-files-watch", ...context.data }, entry.id), contextUserTimestamp: context.data.timestamp });

  return result;
}

function applyCustomEntry(messages: ChatMessage[], entry: PiEntry, resumeMarkers: Set<string>, promptParts: SavedPromptParts) {
  if (entry.customType === "piop-queued-project-context") return appendQueuedProjectContext(messages, entry, true);

  const marker = resumeMarker(entry);

  if (marker) { resumeMarkers.add(marker);

  return checkpointLatestUser(messages, true); }

  if (entry.customType === "pi-desktop-pause-state") {
    const state = pauseStateSchema.safeParse(entry.data);

    if (state.success && state.data.isPaused) return checkpointLatestUser(messages, true);
  }

  if (["piop-context", "pi-desktop-prompt-context"].includes(entry.customType ?? "")) appendPromptContext(messages, entry, promptParts);

  return messages;
}

function compactionMessage(entry: PiEntry): ChatMessage {
  const tokens = z.number().safeParse(entry.tokensBefore);

  return { id: entry.id, entryId: entry.id, role: "system", customType: "compaction", timestamp: entry.timestamp ? Date.parse(entry.timestamp) : undefined, content: tokens.success ? `Context compacted · ${tokens.data.toLocaleString()} tokens before compaction` : "Context compacted" };
}

function customEntryMessage(entry: PiEntry): ChatMessage | undefined {
  if (entry.type === "custom_message" && (entry.display !== false || isContextInjection({ role: "custom", customType: entry.customType }))) {
    return normalizeMessage({ role: "custom", customType: entry.customType, details: entry.details, content: entry.content ?? "", timestamp: entry.timestamp }, entry.id, entry.timestamp);
  }
}

function visibleEntryMessage(entry: PiEntry, resumeMarkers: Set<string>): ChatMessage | undefined {
  if (entry.type === "compaction") return compactionMessage(entry);

  if (entry.type === "custom_message") return customEntryMessage(entry);

  if (entry.type !== "message" || !entry.message || isResumeMessage(entry.message, resumeMarkers)) return undefined;
  const message = normalizeMessage(entry.message, entry.id, entry.timestamp);

  return (["user", "assistant", "tool"] satisfies string[]).includes(message.role) || isContextInjection(message) ? message : undefined;
}

export function branchMessages(entries: PiEntry[], leafId: string | null): ChatMessage[] {
  let messages: ChatMessage[] = []; const resumeMarkers = new Set<string>(); const promptParts: SavedPromptParts = {};

  for (const entry of entryBranch(entries, leafId)) {
    if (entry.type === "custom") { messages = applyCustomEntry(messages, entry, resumeMarkers, promptParts); continue; }

    const message = visibleEntryMessage(entry, resumeMarkers);

    if (message) messages.push(message);
  }

  return messages;
}
