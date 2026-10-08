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

const recoverySchema = Type.Object({ entryId: Type.String(), runId: Type.String(), goalId: Type.Union([Type.String(), Type.Null()]), tokens: accounting,
  state: Type.Union([Type.Literal("recovered"), Type.Literal("missing"), Type.Literal("uncertain"), Type.Literal("unattributed")]) });

const auditSchema = Type.Object({ version: Type.Literal(1), records: Type.Array(recoverySchema) });

const RECOVERY_ENTRY = "piop-goal-usage-recovery";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

export type LegacyUsageRecovery = Static<typeof recoverySchema>;

type Snapshot = { index: number; goalId: string; total: number; receipts: Static<typeof legacyReceiptSchema>[] };

function snapshots(entries: Entry[]) {
  return entries.flatMap((entry, index): Snapshot[] => {
    if (entry.type !== "custom" || entry.customType !== "piop-goal" || !Check(snapshotSchema, entry.data)) return [];
    const data = entry.data;
    const receipts = data.legacySubagentUsage ?? [];
    const recovered = receipts.filter(receipt => receipt.goalId === data.id).reduce((sum, receipt) => sum + receipt.tokens, 0);

    return [{ index, goalId: data.id, total: Math.max(0, data.tokensUsed - recovered), receipts }];
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

function recoveryState(goalId: string | null, entryId: string, index: number, history: Snapshot[], previous?: LegacyUsageRecovery): LegacyUsageRecovery["state"] {
  if (!goalId) return "unattributed";
  const own = history.filter(item => item.goalId === goalId);

  if (own.some(item => item.receipts.some(receipt => receipt.entryId === entryId && receipt.goalId === goalId))) return "recovered";

  if (previous?.goalId === goalId && previous.state !== "recovered") return previous.state;
  const before = own.findLast(item => item.index < index);

  if (!before) return "uncertain";

  return own.some(item => item.index > index && item.total > before.total) ? "uncertain" : "missing";
}

function inspectLegacy(entries: Entry[]) {
  const history = snapshots(entries);
  const ownership = owners(entries);
  const previous = new Map(savedAudit(entries).map(record => [record.entryId, record]));
  const totals = new Map<string, number>();
  const records: LegacyUsageRecovery[] = [];
  entries.forEach((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== "piop-subagent-usage" || !Check(usageSchema, entry.data) || Object.hasOwn(entry.data, "version")) return;
    const usage = entry.data;
    const tokens = Math.min(usage.tokens, Math.max(0, usage.total - (totals.get(usage.runId) ?? 0)));
    totals.set(usage.runId, Math.max(totals.get(usage.runId) ?? 0, usage.total));

    if (!tokens) return;
    const candidates = ownership.get(usage.runId);
    const owner = candidates?.size === 1 ? [...candidates][0] : undefined;

    if (owner === null) return;
    const goalId = owner ?? null;
    records.push({ entryId: entry.id, runId: usage.runId, goalId, tokens, state: recoveryState(goalId, entry.id, index, history, previous.get(entry.id)) });
  });

  return records;
}

export function recoverLegacyUsage(ctx: ExtensionContext, goal: Goal | null) {
  const records = inspectLegacy(ctx.sessionManager.getEntries());

  if (!goal || goal.status === "complete") return records;

  for (const record of records) {
    if (record.state !== "missing" || record.goalId !== goal.id) continue;
    const receipts = goal.legacySubagentUsage ??= [];

    if (!receipts.some(receipt => receipt.entryId === record.entryId && receipt.goalId === goal.id)) {
      goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.tokensUsed + record.tokens);
      receipts.push({ entryId: record.entryId, goalId: goal.id, tokens: record.tokens });
    }

    record.state = "recovered";
  }

  const uncertain = records.filter(record => record.goalId === goal.id && record.state === "uncertain").reduce((sum, record) => Math.min(Number.MAX_SAFE_INTEGER, sum + record.tokens), 0);

  if (uncertain) goal.legacyUsageUncertainTokens = uncertain;
  else delete goal.legacyUsageUncertainTokens;

  return records;
}

export function saveLegacyRecovery(pi: ExtensionAPI, ctx: ExtensionContext, records: LegacyUsageRecovery[]) {
  if (JSON.stringify(savedAudit(ctx.sessionManager.getEntries())) === JSON.stringify(records)) return;
  pi.appendEntry(RECOVERY_ENTRY, { version: 1, records: structuredClone(records) });
}
