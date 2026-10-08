import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Goal } from "./goal-state.ts";
import { resultNotificationId } from "./subagent-identity.ts";

const accounting = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const legacyReceiptSchema = Type.Object({ entryId: Type.String(), goalId: Type.String(), tokens: accounting });

const snapshotSchema = Type.Object({ id: Type.String(), tokensUsed: accounting, legacySubagentUsage: Type.Optional(Type.Array(legacyReceiptSchema)) });

const runSchema = Type.Object({ parentSessionId: Type.String(), sessionId: Type.String(), toolCallId: Type.String(), startedAt: Type.Number(), goalId: Type.Optional(Type.String()), offset: Type.Optional(accounting) });

const usageSchema = Type.Object({ runId: Type.String(), total: accounting, tokens: accounting });

const oldUsageSchema = Type.Object({ runId: Type.Optional(Type.Unknown()), total: Type.Optional(Type.Unknown()), tokens: Type.Optional(Type.Unknown()) });

const recoverySchema = Type.Object({ entryId: Type.String(), runId: Type.Union([Type.String(), Type.Null()]), goalId: Type.Union([Type.String(), Type.Null()]), tokens: Type.Union([accounting, Type.Null()]),
  state: Type.Union([Type.Literal("recovered"), Type.Literal("missing"), Type.Literal("uncertain"), Type.Literal("unattributed"), Type.Literal("invalid")]) });

const auditSchema = Type.Object({ version: Type.Literal(1), records: Type.Array(recoverySchema) });

const RECOVERY_ENTRY = "piop-goal-usage-recovery";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

export type LegacyUsageRecovery = Static<typeof recoverySchema>;

type Snapshot = { index: number; goalId: string; total: number | null; receipts: Static<typeof legacyReceiptSchema>[] };

function snapshots(entries: Entry[]) {
  return entries.flatMap((entry, index): Snapshot[] => {
    if (entry.type !== "custom" || entry.customType !== "piop-goal" || !Check(snapshotSchema, entry.data)) return [];
    const data = entry.data;
    const receipts = data.legacySubagentUsage ?? [];
    const recovered = receipts.filter(receipt => receipt.goalId === data.id).reduce((sum, receipt) => sum + receipt.tokens, 0);
    const valid = Number.isSafeInteger(recovered) && recovered <= data.tokensUsed && data.tokensUsed < Number.MAX_SAFE_INTEGER;

    return [{ index, goalId: data.id, total: valid ? data.tokensUsed - recovered : null, receipts }];
  });
}

function owners(entries: Entry[]) {
  const result = new Map<string, Set<string | null>>();

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "piop-subagent-run" || !Check(runSchema, entry.data)) continue;
    const run = entry.data;

    if (!run.goalId && run.offset === undefined) continue;
    const key = resultNotificationId(run);
    const found = result.get(key) ?? new Set();
    found.add(run.goalId ?? null);
    result.set(key, found);
  }

  return result;
}

function savedAudit(entries: Entry[]) {
  const entry = [...entries].reverse().find(item => item.type === "custom" && item.customType === RECOVERY_ENTRY);

  return entry?.type === "custom" && Check(auditSchema, entry.data) ? entry.data.records : [];
}

function missingFromSnapshots(own: Snapshot[], index: number): LegacyUsageRecovery["state"] {
  const before = own.findLast(item => item.index < index);
  const baseline = before?.total;

  if (baseline == null || own.some(item => item.total === null)) return "uncertain";

  return own.some(item => item.index > index && item.total !== null && item.total > baseline) ? "uncertain" : "missing";
}

function recoveryState(goalId: string | null, entryId: string, index: number, history: Snapshot[], previous?: LegacyUsageRecovery): LegacyUsageRecovery["state"] {
  if (!goalId) return "unattributed";
  const own = history.filter(item => item.goalId === goalId);

  if (own.some(item => item.receipts.some(receipt => receipt.entryId === entryId && receipt.goalId === goalId))) return "recovered";

  if (previous?.goalId === goalId && previous.state !== "recovered") return previous.state;

  return missingFromSnapshots(own, index);
}

function legacyUsage(entry: Entry, totals: Map<string, number>) {
  if (entry.type !== "custom" || entry.customType !== "piop-subagent-usage") return;

  if (!Check(oldUsageSchema, entry.data)) return { runId: null, tokens: null, valid: false, state: "invalid" };

  if (Object.hasOwn(entry.data, "version")) return;
  const data = entry.data;
  const record = { runId: Check(Type.String(), data.runId) ? data.runId : null, tokens: Check(accounting, data.tokens) ? data.tokens : null };

  if (!Check(usageSchema, data)) return { ...record, valid: false, state: Object.hasOwn(data, "total") ? "invalid" : "unattributed" };
  const previous = totals.get(data.runId) ?? Math.max(0, data.total - data.tokens);
  totals.set(data.runId, Math.max(previous, data.total));
  const valid = data.total - previous === data.tokens;

  return { ...record, valid, state: "invalid" };
}

function inspectLegacy(entries: Entry[]) {
  const history = snapshots(entries);
  const ownership = owners(entries);
  const previous = new Map(savedAudit(entries).map(record => [record.entryId, record]));
  const totals = new Map<string, number>();
  const records: LegacyUsageRecovery[] = [];
  entries.forEach((entry, index) => {
    const usage = legacyUsage(entry, totals);

    if (!usage || usage.tokens === 0 && usage.valid) return;
    const candidates = usage.runId === null ? undefined : ownership.get(usage.runId);
    const owner = candidates?.size === 1 ? [...candidates][0] : undefined;

    if (owner === null) return;
    const goalId = owner ?? null;
    const state = usage.valid ? recoveryState(goalId, entry.id, index, history, previous.get(entry.id)) : usage.state === "invalid" ? "invalid" : "unattributed";
    records.push({ entryId: entry.id, runId: usage.runId, goalId, tokens: usage.tokens, state });
  });

  return records;
}

export function recoverLegacyUsage(ctx: ExtensionContext, goal: Goal | null) {
  const records = inspectLegacy(ctx.sessionManager.getEntries());

  if (!goal || goal.status === "complete") return records;

  for (const record of records) {
    if (record.state !== "missing" || record.goalId !== goal.id || record.tokens === null) continue;

    if (goal.tokensUsed > Number.MAX_SAFE_INTEGER - record.tokens) { record.state = "uncertain";

    continue; }
    const receipts = goal.legacySubagentUsage ??= [];

    if (!receipts.some(receipt => receipt.entryId === record.entryId && receipt.goalId === goal.id)) {
      goal.tokensUsed += record.tokens;
      receipts.push({ entryId: record.entryId, goalId: goal.id, tokens: record.tokens });
    }

    record.state = "recovered";
  }

  const uncertain = records.filter(record => record.goalId === goal.id && record.state === "uncertain").reduce((sum, record) => Math.min(Number.MAX_SAFE_INTEGER, sum + (record.tokens ?? 0)), 0);

  if (uncertain) goal.legacyUsageUncertainTokens = uncertain;
  else delete goal.legacyUsageUncertainTokens;

  return records;
}

export function saveLegacyRecovery(pi: ExtensionAPI, ctx: ExtensionContext, records: LegacyUsageRecovery[]) {
  if (JSON.stringify(savedAudit(ctx.sessionManager.getEntries())) === JSON.stringify(records)) return;
  pi.appendEntry(RECOVERY_ENTRY, { version: 1, records: structuredClone(records) });
}

export function legacyRecoveryReport(records: LegacyUsageRecovery[]) {
  return records.length ? { records, explanation: "Recovered tokens were missing from this goal's saved total. Uncertain records may already be counted; existing totals are preserved. Missing records for cleared or completed goals remain recorded without reopening those goals. Unattributed records have no unambiguous saved goal owner. Invalid records have inconsistent token counters and are preserved for inspection using their original entry IDs." } : undefined;
}
