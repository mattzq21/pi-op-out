import type { ChatMessage } from "../types";
import { pluginMessageMetadata } from "../plugins/messageMetadata";
import { z } from "zod";
import { promptContextSchema, wireMessageSchema, type WireMessage } from "./messageSchemas";

const SYSTEM_MESSAGES = new Set(["pi-desktop-mcp-status", "piop-auxiliary-note"]);

/** The user message that a goal sends to continue its work. */
export const GOAL_PROMPT = "piop-goal-context";

export function isContextInjection(message: { role?: string; customType?: string }) {
  return message.role === "custom" && (pluginMessageMetadata(message.customType)?.contextInjection ?? (!SYSTEM_MESSAGES.has(message.customType ?? "") && !["piop-subagent-result", "piop-session-operation", "piop-agent-message", GOAL_PROMPT].includes(message.customType ?? "")));
}

/** tokensAfter: the daemon adds it to compaction entries from the first model call after the compaction. */
export type PiEntry = { type: string; id: string; parentId: string | null; message?: Partial<WireMessage>; customType?: string; details?: unknown; content?: ChatMessage["content"]; data?: unknown; display?: boolean; timestamp?: string; tokensBefore?: number; tokensAfter?: number };

const entryIdentitySchema = z.object({ id: z.string() });

function replaceMessage(messages: ChatMessage[], index: number, message: ChatMessage, inPlace: boolean) {
  const result = inPlace ? messages : messages.slice();
  result[index] = message;

  return result;
}

/** A message that starts a turn: one the user sent, a goal prompt, or a message or subagent result from another agent session. */
export const isPromptMessage = (message: ChatMessage) => message.role === "user" || (message.role === "custom" && (message.customType === "piop-agent-message" || message.customType === "piop-subagent-result" || message.customType === GOAL_PROMPT));

/** Whether a prompt context snapshot belongs to this message. */
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

/** The tool entry title, such as "read" or "read(image)" when the result contains an image. */
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

function applyCustomEntry(messages: ChatMessage[], entry: PiEntry, promptParts: SavedPromptParts) {
  if (entry.customType === "piop-queued-project-context") return appendQueuedProjectContext(messages, entry, true);

  if (["piop-context", "pi-desktop-prompt-context"].includes(entry.customType ?? "")) appendPromptContext(messages, entry, promptParts);

  return messages;
}

const compactionTokensSchema = z.object({ tokensBefore: z.number(), tokensAfter: z.number().optional() });

function compactionContent(tokens: z.infer<typeof compactionTokensSchema>) {
  const before = tokens.tokensBefore.toLocaleString();

  return tokens.tokensAfter === undefined ? `Context compacted · ${before} tokens before compaction` : `Context compacted · ${before} → ${tokens.tokensAfter.toLocaleString()} tokens`;
}

function compactionMessage(entry: PiEntry): ChatMessage {
  const tokens = compactionTokensSchema.safeParse({ tokensBefore: entry.tokensBefore, tokensAfter: entry.tokensAfter });

  return { id: entry.id, entryId: entry.id, role: "system", customType: "compaction", timestamp: entry.timestamp ? Date.parse(entry.timestamp) : undefined, details: tokens.success ? tokens.data : undefined, content: tokens.success ? compactionContent(tokens.data) : "Context compacted" };
}

const countsAsModelCall = (message: ChatMessage) => message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error";

/** Sets the context size after the last compaction from the prompt tokens of reply, when reply is the first model call after it. */
export function withTokensAfterCompaction(messages: ChatMessage[], reply: ChatMessage): ChatMessage[] {
  if (!countsAsModelCall(reply) || !reply.usage) return messages;
  const tokensAfter = reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite;

  if (!Number.isFinite(tokensAfter) || tokensAfter <= 0) return messages;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message.id === reply.id) continue;

    if (countsAsModelCall(message)) return messages;

    if (message.customType !== "compaction") continue;
    const saved = compactionTokensSchema.safeParse(message.details);

    if (!saved.success || saved.data.tokensAfter !== undefined) return messages;
    const tokens = { ...saved.data, tokensAfter };

    return replaceMessage(messages, index, { ...message, details: tokens, content: compactionContent(tokens) }, false);
  }

  return messages;
}

function customEntryMessage(entry: PiEntry): ChatMessage | undefined {
  if (entry.type === "custom_message" && (entry.display !== false || isContextInjection({ role: "custom", customType: entry.customType }))) {
    return normalizeMessage({ role: "custom", customType: entry.customType, details: entry.details, content: entry.content ?? "", timestamp: entry.timestamp }, entry.id, entry.timestamp);
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

    if (message) { messages = withTokensAfterCompaction(messages, message); messages.push(message); }
  }

  return messages;
}
