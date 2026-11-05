import type { ChatMessage } from "../types";
import { z } from "zod";
import { promptContextSchema, wireMessageSchema, type WireMessage } from "./messageSchemas";

const SYSTEM_MESSAGES = new Set(["pi-desktop-mcp-status"]);

export const GOAL_PROMPT = "piop-goal-context";

export function isContextInjection(message: { role?: string; customType?: string; pluginMessage?: ChatMessage["pluginMessage"] }) {
  return message.role === "custom" && (message.pluginMessage?.contextInjection ?? (!SYSTEM_MESSAGES.has(message.customType ?? "") && !["piop-subagent-result", "piop-session-operation", "piop-agent-message", GOAL_PROMPT].includes(message.customType ?? "")));
}

export type PiEntry = { type: string; id: string; parentId: string | null; message?: Partial<WireMessage>; customType?: string; pluginMessage?: ChatMessage["pluginMessage"]; details?: unknown; content?: ChatMessage["content"]; data?: unknown; display?: boolean; timestamp?: string; tokensBefore?: number };

const entryIdentitySchema = z.object({ id: z.string() });

function replaceMessage(messages: ChatMessage[], index: number, message: ChatMessage, inPlace: boolean) {
  const result = inPlace ? messages : messages.slice();
  result[index] = message;

  return result;
}

export const isPromptMessage = (message: ChatMessage) => message.role === "user" || (message.role === "custom" && (message.customType === "piop-agent-message" || message.customType === "piop-subagent-result" || message.customType === GOAL_PROMPT));

export const promptContextAnchors = (message: ChatMessage, context: { userTimestamp?: number; agentNotificationId?: string }) => message.role === "user"
  ? context.userTimestamp !== undefined && message.timestamp === context.userTimestamp
  : context.agentNotificationId !== undefined && isPromptMessage(message) && (message.details as { notificationId?: unknown } | undefined)?.notificationId === context.agentNotificationId;

function latestUser(messages: ChatMessage[]) {
  let index = messages.length - 1;

  while (index >= 0 && !isPromptMessage(messages[index])) index--;

  return index;
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
  const customRole = source.pluginMessage?.customRole;

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

  const metadata = source.pluginMessage;

  if (metadata?.toolName !== undefined) normalized.toolName = metadata.toolName;

  if (metadata?.toolStatus !== undefined) normalized.toolStatus = metadata.toolStatus;

  if (Number.isFinite(completionStamp)) normalized.completedAt = completionStamp;

  return normalized;
}

export { applyAssistantMessageEvent } from "./messageEvents";

export function toolTitle(message: ChatMessage): string {
  const name = message.toolName || "tool";
  return message.toolImage ? `${name}(image)` : name;
}

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

function applyCustomEntry(messages: ChatMessage[], entry: PiEntry, promptParts: SavedPromptParts) {
  if (entry.customType === "piop-queued-project-context") return appendQueuedProjectContext(messages, entry, true);

  if (entry.customType === "piop-compaction-timing") return applyCompactionTiming(messages, entry);

  if (["piop-context", "pi-desktop-prompt-context"].includes(entry.customType ?? "")) appendPromptContext(messages, entry, promptParts);

  return messages;
}

const compactionTimingSchema = z.object({ compactionId: z.string(), startedAt: z.number() });

function applyCompactionTiming(messages: ChatMessage[], entry: PiEntry) {
  const timing = compactionTimingSchema.parse(entry.data);
  const index = messages.findIndex(message => message.id === timing.compactionId);

  if (index >= 0) messages[index] = { ...messages[index], startedAt: timing.startedAt };

  return messages;
}

function compactionMessage(entry: PiEntry): ChatMessage {
  const tokensBefore = entry.tokensBefore;

  return { id: entry.id, entryId: entry.id, role: "system", customType: "compaction", timestamp: entry.timestamp ? Date.parse(entry.timestamp) : undefined, content: tokensBefore === undefined ? "Compacted" : `Compacted from ${compactionTokens(tokensBefore)}` };
}

function compactionTokens(tokens: number) {
  if (tokens < 1000) return `${tokens} tokens`;
  if (tokens < 10000) return `${Number((tokens / 1000).toFixed(1))}k tokens`;
  return `${Math.round(tokens / 1000)}k`;
}

function customEntryMessage(entry: PiEntry): ChatMessage | undefined {
  if (entry.type === "custom_message" && (entry.display !== false || isContextInjection({ role: "custom", customType: entry.customType, pluginMessage: entry.pluginMessage }))) {
    return normalizeMessage({ role: "custom", customType: entry.customType, pluginMessage: entry.pluginMessage, details: entry.details, content: entry.content ?? "", timestamp: entry.timestamp }, entry.id, entry.timestamp);
  }
}

function visibleEntryMessage(entry: PiEntry): ChatMessage | undefined {
  if (entry.type === "compaction") return compactionMessage(entry);

  if (entry.type === "custom_message") return customEntryMessage(entry);

  if (entry.type !== "message" || !entry.message) return undefined;
  const message = normalizeMessage(entry.message, entry.id, entry.timestamp);

  return (["user", "assistant", "tool"] satisfies string[]).includes(message.role) || isContextInjection(message) ? message : undefined;
}

export function branchMessages(entries: PiEntry[], leafId: string | null): ChatMessage[] {
  let messages: ChatMessage[] = []; const promptParts: SavedPromptParts = {};

  for (const entry of entryBranch(entries, leafId)) {
    if (entry.type === "custom") { messages = applyCustomEntry(messages, entry, promptParts); continue; }

    const message = visibleEntryMessage(entry);

    if (message) messages.push(message);
  }

  return messages;
}
