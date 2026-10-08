import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { goalTokens } from "./goal-state.ts";

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String() });

const usageSchema = Type.Object({ input: Type.Optional(Type.Number()), output: Type.Optional(Type.Number()), cacheWrite: Type.Optional(Type.Number()), cost: Type.Optional(Type.Object({ total: Type.Optional(Type.Number()) })) });

const entrySchema = Type.Object({ id: Type.Optional(Type.String()), type: Type.String(), usage: Type.Optional(usageSchema), message: Type.Optional(Type.Unknown()) });

const assistantSchema = Type.Object({ role: Type.Literal("assistant"), timestamp: Type.Optional(Type.Number()), usage: Type.Optional(usageSchema), piopSubagentUsageId: Type.Optional(Type.String()) });

const descendantSchema = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal("piop-subagent-usage"), data: Type.Object({ tokens: Type.Integer({ minimum: 0 }) }) });

const selfUsageSchema = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal("piop-subagent-self-usage"), data: Type.Object({ eventId: Type.String(), tokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), apiCost: Type.Number({ minimum: 0 }) }) });

const legacyUsageSchema = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal("piop-subagent-response-usage"), data: Type.Object({ key: Type.String(), tokens: Type.Integer({ minimum: 0 }) }) });

function unrecordedTokens(assistant: Static<typeof assistantSchema>, tokens: number, recorded: Map<string, number>) {
  const key = JSON.stringify([assistant.timestamp, tokens]);
  const previous = recorded.get(key) ?? 0;

  if (!previous) return tokens;
  recorded.set(key, previous - 1);

  return 0;
}

function entryKey(entry: Static<typeof entrySchema>, offset: number) {
  if (Check(assistantSchema, entry.message) && entry.message.piopSubagentUsageId) return `assistant:${entry.message.piopSubagentUsageId}`;

  return `entry:${entry.id ?? offset}`;
}

function entryUsage(entry: Static<typeof entrySchema>, offset: number, recorded: Map<string, number>) {
  const assistant = Check(assistantSchema, entry.message) ? entry.message : undefined;
  const usage = assistant?.usage ?? entry.usage;
  const tokens = assistant ? unrecordedTokens(assistant, goalTokens(usage), recorded) : goalTokens(usage);
  const amount = usage?.cost?.total ?? 0;
  const apiCost = Number.isFinite(amount) ? Math.max(0, amount) : 0;

  return { id: entryKey(entry, offset), tokens, apiCost };
}

export async function transcriptUsage(run: { sessionPath: string; sessionId: string; offset?: number; offsetHeader?: string }) {
  let tokens = 0;
  let apiCost = 0;
  const self = new Map<string, { tokens: number; apiCost: number }>();
  const recorded = new Map<string, number>();

  for await (const { line, offset } of transcriptLines(run.sessionPath, run.offset ?? 0, run.sessionId, run.offsetHeader)) {
    let entry;

    try { entry = JSON.parse(line); } catch { continue; }

    if (Check(descendantSchema, entry)) { tokens += entry.data.tokens; continue; }

    if (Check(selfUsageSchema, entry)) { self.set(entry.data.eventId, entry.data); continue; }

    if (Check(legacyUsageSchema, entry)) { tokens += entry.data.tokens; recorded.set(entry.data.key, (recorded.get(entry.data.key) ?? 0) + 1); continue; }

    if (!Check(entrySchema, entry)) continue;
    const usage = entryUsage(entry, offset, recorded);
    self.set(usage.id, usage);
  }

  for (const usage of self.values()) { tokens += usage.tokens; apiCost += usage.apiCost; }

  return { tokens: Math.min(Number.MAX_SAFE_INTEGER, tokens), apiCost };
}

async function transcriptHeader(file: FileHandle, sessionId: string) {
  const buffer = Buffer.alloc(65536);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  const end = buffer.subarray(0, bytesRead).indexOf(10);

  if (end < 0) throw new Error("Conversation header is incomplete or exceeds its size limit");
  const line = buffer.subarray(0, end);
  const header = JSON.parse(line.toString("utf8"));

  if (!Check(headerSchema, header) || header.id !== sessionId) throw new Error("The transcript at this path belongs to another conversation");

  return createHash("sha256").update(line).digest("hex");
}

export async function transcriptMetadata(path: string, sessionId: string) {
  const file = await open(path, "r");

  try { return { header: await transcriptHeader(file, sessionId), size: (await file.stat()).size }; }
  finally { await file.close(); }
}

export async function* transcriptLines(path: string, start = 0, sessionId?: string, expectedHeader?: string) {
  const file = await open(path, "r");
  let input;
  let pending = Buffer.alloc(0);
  let offset = start;

  try {
    if (sessionId) {
      const header = await transcriptHeader(file, sessionId);

      if (expectedHeader && header !== expectedHeader) throw new Error("The conversation moved during usage accounting; retry with its current task boundary");
    }

    input = file.createReadStream({ start, autoClose: false });

    for await (const chunk of input) {
      pending = Buffer.concat([pending, chunk]);
      let end = pending.indexOf(10);

      while (end >= 0) {
        const next = offset + end + 1;
        yield { line: pending.subarray(0, end).toString("utf8"), offset, next };
        pending = pending.subarray(end + 1);
        offset = next;
        end = pending.indexOf(10);
      }
    }

    if (pending.length) yield { line: pending.toString("utf8"), offset, next: offset + pending.length };
  } finally { input?.destroy(); await file.close(); }
}
