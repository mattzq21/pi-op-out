import type { ChatMessage, FileChangeSnapshot, PromptContextInfo } from "../types";

const visibleUserContent = (content: unknown) => content;

const SYSTEM_MESSAGES = new Set(["pi-desktop-mcp-status", "pi-desktop-catch-up", "piop-review-link"]);

export type PiEntry = { type: string; id: string; parentId: string | null; message?: Omit<ChatMessage, "id" | "entryId"> & { role: string; timestamp?: number }; customType?: string; details?: unknown; content?: ChatMessage["content"]; data?: unknown; display?: boolean; timestamp?: string; tokensBefore?: number };

function validFileChanges(data: Partial<FileChangeSnapshot> | undefined): data is FileChangeSnapshot {
  return Boolean(data && typeof data.cwd === "string" && typeof data.patch === "string" && Array.isArray(data.toolCallIds) && Array.isArray(data.paths));
}

function replaceMessage(messages: ChatMessage[], index: number, message: ChatMessage, inPlace: boolean) {
  const result = inPlace ? messages : messages.slice();
  result[index] = message;

  return result;
}

export function appendFileChanges(messages: ChatMessage[], entry: PiEntry, inPlace = false): ChatMessage[] {
  if (entry.type !== "custom" || entry.customType !== "piop-file-changes") return messages;
  const data = entry.data as Partial<FileChangeSnapshot> | undefined;

  if (!validFileChanges(data)) return messages;
  const ids = new Set(data.toolCallIds);
  const index = latestMatchingTool(messages, ids);

  if (index < 0) return messages;
  const toolPaths = Array.isArray(data.toolPaths) ? data.toolPaths.filter((value) => value && typeof value === "object" && typeof value.toolCallId === "string" && typeof value.path === "string" && typeof value.absolutePath === "string" && typeof value.canonicalPath === "string") : [];
  const snapshot: FileChangeSnapshot = { id: entry.id, cwd: data.cwd, patch: data.patch, toolCallIds: data.toolCallIds.filter((id) => typeof id === "string"), toolPaths, paths: data.paths.filter((path) => typeof path === "string"), warnings: Array.isArray(data.warnings) ? data.warnings.filter((value) => typeof value === "string") : [] };
  const message = messages[index];

  return replaceMessage(messages, index, { ...message, fileChanges: [...(message.fileChanges ?? []).filter((change) => change.id !== entry.id), snapshot] }, inPlace);
}

function latestMatchingTool(messages: ChatMessage[], ids: Set<string>) {
  let index = messages.length - 1;

  while (index >= 0 && !(messages[index].role === "tool" && ids.has(messages[index].toolCallId ?? messages[index].id))) index--;

  return index;
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

function latestUser(messages: ChatMessage[]) {
  let index = messages.length - 1;

  while (index >= 0 && messages[index].role !== "user") index--;

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

function messageTimestamp(source: Record<string, unknown>) {
  const numericStamp = Number((source satisfies { timestamp?: unknown }).timestamp || Date.now());

  return Number.isFinite(numericStamp) ? numericStamp : Date.parse(String((source satisfies { timestamp?: unknown }).timestamp)) || Date.now();
}

function messageRole(source: Record<string, unknown>): ChatMessage['role'] {
  const isBtw = source.role === "custom" && source.customType === "pi-desktop-btw";
  const isSystemMessage = source.role === "custom" && SYSTEM_MESSAGES.has(String(source.customType));

  return (source.role === 'toolResult' ? 'tool' : isBtw ? 'assistant' : isSystemMessage ? 'system' : source.role) as ChatMessage['role'];
}

function messageIdentity(source: Record<string, unknown>, stamp: number, entryId?: string, fallbackId?: string) {
  return entryId || fallbackId || (typeof source.id === 'string' ? source.id : undefined) || `live-${String(source.role ?? 'message')}-${stamp}`;
}

export function normalizeMessage(message: Record<string, unknown> | null | undefined, entryId?: string, completedAt?: string, fallbackId?: string): ChatMessage {
  const source = (message && typeof message === "object" ? message : {}) satisfies Record<string, unknown>;
  const stamp = messageTimestamp(source);
  const completionStamp = completedAt ? Date.parse(completedAt) : NaN;

  return { ...(source as unknown as ChatMessage), ...(source.role === "user" ? { content: visibleUserContent(source.content) as ChatMessage["content"] } : {}), id: messageIdentity(source, stamp, entryId, fallbackId), entryId, role: messageRole(source), toolStatus: source.role === "toolResult" ? ((source satisfies { isError?: unknown }).isError ? "error" : "done") : undefined, timestamp: stamp, ...(Number.isFinite(completionStamp) ? { completedAt: completionStamp } : {}) };
}

export { applyAssistantMessageEvent } from "./messageEvents";

function entryBranch(entries: PiEntry[], leafId: string | null): PiEntry[] {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map<string, PiEntry>();

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || typeof (entry satisfies PiEntry).id !== "string") continue;

    if (!byId.has((entry satisfies PiEntry).id)) byId.set((entry satisfies PiEntry).id, entry satisfies PiEntry);
  }

  const branch: PiEntry[] = []; const visited = new Set<string>(); let cursor = leafId;

  while (cursor && !visited.has(cursor)) { visited.add(cursor); const entry = byId.get(cursor);

  if (!entry) break; branch.push(entry); cursor = entry.parentId; }

  return branch.reverse();
}

function appendPromptContext(messages: ChatMessage[], entry: PiEntry) {
  const userIndex = latestUser(messages);

  if (userIndex >= 0 && !messages[userIndex].promptContext) messages[userIndex] = { ...messages[userIndex], promptContext: entry.data as PromptContextInfo };
}

function applyCustomEntry(messages: ChatMessage[], entry: PiEntry, resumeMarkers: Set<string>) {
  if (entry.customType === "piop-file-changes") return appendFileChanges(messages, entry, true);
  const marker = resumeMarker(entry);

  if (marker) { resumeMarkers.add(marker);

  return checkpointLatestUser(messages, true); }

  if (entry.customType === "pi-desktop-pause-state" && (entry.data as { isPaused?: boolean } | undefined)?.isPaused) return checkpointLatestUser(messages, true);

  if (["piop-context", "pi-desktop-prompt-context"].includes(entry.customType ?? "")) appendPromptContext(messages, entry);

  return messages;
}

function compactionMessage(entry: PiEntry): ChatMessage {
  return { id: entry.id, entryId: entry.id, role: "system", customType: "compaction", timestamp: entry.timestamp ? Date.parse(entry.timestamp) : undefined, content: typeof entry.tokensBefore === "number" ? `Context compacted · ${entry.tokensBefore.toLocaleString()} tokens before compaction` : "Context compacted" };
}

function visibleEntryMessage(entry: PiEntry, resumeMarkers: Set<string>): ChatMessage | undefined {
  if (entry.type === "compaction") return compactionMessage(entry);

  if (entry.type === "custom_message" && entry.customType !== "pi-desktop-btw" && entry.display !== false) {
    return normalizeMessage({ role: "custom", customType: entry.customType, details: entry.details, content: entry.content ?? "", timestamp: entry.timestamp }, entry.id, entry.timestamp);
  }

  if (entry.type !== "message" || !entry.message || isResumeMessage(entry.message, resumeMarkers)) return undefined;
  const message = normalizeMessage(entry.message satisfies unknown as Record<string, unknown>, entry.id, entry.timestamp);

  return (["user", "assistant", "tool"] satisfies string[]).includes(message.role) ? message : undefined;
}

export function branchMessages(entries: PiEntry[], leafId: string | null): ChatMessage[] {
  let messages: ChatMessage[] = []; const resumeMarkers = new Set<string>();

  for (const entry of entryBranch(entries, leafId)) {
    if (entry.type === "custom") { messages = applyCustomEntry(messages, entry, resumeMarkers); continue; }

    const message = visibleEntryMessage(entry, resumeMarkers);

    if (message) messages.push(message);
  }

  return messages;
}
