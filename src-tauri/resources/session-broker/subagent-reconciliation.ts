import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GoalScope, GoalUsage } from "./goals.ts";
import { goalTokens } from "./goal-state.ts";
import { listenSubagentUsage, type UsageCheckpoint } from "./subagent-usage.ts";
import { branchEntries, interruptSession, sendSessionMessage, sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { saveRun, type SubagentRun } from "./subagent-state.ts";
import { transcriptLines } from "./subagent-transcript.ts";

const usageSchema = Schema.Object({ input: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.Number()), cacheWrite: Schema.Optional(Schema.Number()), cost: Schema.Optional(Schema.Object({ total: Schema.Optional(Schema.Number()) })) });

const entrySchema = Schema.Object({ id: Schema.Optional(Schema.String()), type: Schema.String(), usage: Schema.Optional(usageSchema), message: Schema.Optional(Schema.Unknown()) });

const descendantSchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal("piop-subagent-usage"), data: Schema.Object({ tokens: Schema.Integer({ minimum: 0 }) }) });

const assistantSchema = Schema.Object({ role: Schema.Literal("assistant"), stopReason: Schema.String(), errorMessage: Schema.Optional(Schema.String()), content: Schema.Array(Schema.Unknown()), usage: Schema.Optional(usageSchema), piopSubagentUsageId: Schema.Optional(Schema.String()) });

const selfUsageSchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal("piop-subagent-self-usage"), data: Schema.Object({ eventId: Schema.String(), tokens: Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), apiCost: Schema.Number({ minimum: 0 }) }) });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

const usageCheckpointSchema = Schema.Object({ runId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), total: Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), sourceTotals: Schema.Optional(Schema.Record(Schema.String(), Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))) });

export const subagentReceiptSchema = Schema.Object({ accepted: Schema.Literal(true), notificationId: Schema.String() });

const taskMessageSchema = Schema.Object({ sourceSessionId: Schema.String(), message: Schema.String() });

export type ActiveSubagent = {
  controller: AbortController; done: Promise<void>; ready: Promise<void>; started: () => void; closing: boolean;
  revision: number; pendingDeliveries: number; deliveryIds: Set<string>; run?: SubagentRun;
};

export class SubagentCancellation extends Error {}

type Observation = {
  pi: ExtensionAPI; ctx: ExtensionContext; signal: AbortSignal;
  reportDescendants: (tokens: number, ctx: ExtensionContext, checkpoint?: UsageCheckpoint) => Promise<void>;
};

export function cancelSubagent(pi: ExtensionAPI, ctx: ExtensionContext, lifecycle: ActiveSubagent, reason: string) {
  const run = lifecycle.run;

  if (run?.status === "running") {
    run.cancelRequested = true;
    run.cancelReason = reason;
    saveRun(pi, ctx, run);
  }

  lifecycle.controller.abort(new SubagentCancellation(reason));
}

function cost(usage: Static<typeof usageSchema> | undefined) {
  const amount = usage?.cost?.total;

  return amount !== undefined && Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

async function transcriptUsage(run: SubagentRun) {
  let tokens = 0;
  let apiCost = 0;
  const self = new Map<string, { tokens: number; apiCost: number }>();

  for await (const { line, offset } of transcriptLines(run.sessionPath, run.offset ?? 0)) {
    let entry;

    try { entry = JSON.parse(line); } catch { continue; }

    if (Check(descendantSchema, entry)) { tokens += entry.data.tokens; continue; }

    if (Check(selfUsageSchema, entry)) { self.set(entry.data.eventId, entry.data); continue; }

    if (Check(entrySchema, entry)) self.set(usageKey(entry, offset), { tokens: goalTokens(entryUsage(entry)), apiCost: cost(entryUsage(entry)) });
  }

  for (const usage of self.values()) {
    tokens += usage.tokens;
    apiCost += usage.apiCost;
  }

  return { tokens: Math.min(Number.MAX_SAFE_INTEGER, tokens), apiCost };
}

function entryUsage(entry: Static<typeof entrySchema>) {
  return entry.type === "message" && Check(assistantSchema, entry.message) ? entry.message.usage : entry.usage;
}

function usageKey(entry: Static<typeof entrySchema>, offset: number) {
  if (Check(assistantSchema, entry.message) && entry.message.piopSubagentUsageId) return `assistant:${entry.message.piopSubagentUsageId}`;

  return `entry:${entry.id ?? offset}`;
}

async function legacyOffset(run: SubagentRun, snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const branch = branchEntries(snapshot);
  const index = taskObserved(run, branch);

  if (index < 0) throw new Error("Cannot identify this legacy run's submitted task on the child's selected branch");
  const id = branch[index].id;
  let offset: number | undefined;

  for await (const { line, next } of transcriptLines(run.sessionPath)) {
    let entry;

    try { entry = JSON.parse(line); } catch { continue; }

    if (Check(Schema.Object({ id: Schema.Literal(id) }), entry)) offset = next;
  }

  if (offset === undefined) throw new Error("The child transcript no longer contains the observed task boundary");

  return offset;
}

function legacyCredits(run: SubagentRun, ctx: ExtensionContext) {
  let credits = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "piop-subagent-usage" || Date.parse(entry.timestamp) < run.startedAt) continue;

    if (Check(Schema.Object({ tokens: Schema.Integer({ minimum: 0 }), runId: Schema.Optional(Schema.String()) }), entry.data) && entry.data.runId === undefined) credits += entry.data.tokens;
  }

  return Math.min(Number.MAX_SAFE_INTEGER, credits);
}

async function initializeLegacy(run: SubagentRun, observation: Observation, snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  run.offset = await legacyOffset(run, snapshot);
  const usage = await transcriptUsage(run);
  const credits = Math.min(usage.tokens, legacyCredits(run, observation.ctx));
  run.legacyCredits = credits;
  run.accountedTokens = credits;
  run.goalTokens = credits;
  run.forwardedTokens = credits;
  saveRun(observation.pi, observation.ctx, run);
}

function accountedTokens(run: SubagentRun, ctx: ExtensionContext) {
  let total = run.accountedTokens ?? 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "piop-subagent-usage" && Check(usageCheckpointSchema, entry.data) && sameRun(entry.data, run)) total = Math.max(total, entry.data.total);
  }

  return total;
}

function sameRun(checkpoint: Static<typeof usageCheckpointSchema>, run: SubagentRun) {
  return checkpoint.runId === run.runId && checkpoint.parentSessionId === run.parentSessionId && checkpoint.sessionId === run.sessionId;
}

export async function settleAccounting(run: SubagentRun, observation: Observation) {
  const { pi, ctx } = observation;
  const total = accountedTokens(run, ctx);
  const sourceId = JSON.stringify([run.parentSessionId, run.sessionId, run.runId]);

  if (run.goalId && total > (run.goalTokens ?? 0)) {
    const event: GoalUsage = { goalId: run.goalId, tokens: total - (run.goalTokens ?? 0), ctx, sourceId, total: uncredited(run, total) };
    pi.events.emit("piop:goal-usage", event);

    if (!event.ready) throw new Error("Cumulative subagent goal accounting is unavailable");
    await event.ready;
    run.goalTokens = total;
    saveRun(pi, ctx, run);
  }

  if (total > (run.forwardedTokens ?? 0)) {
    await observation.reportDescendants(total - (run.forwardedTokens ?? 0), ctx, { sourceId, total: uncredited(run, total) });
    run.forwardedTokens = total;
    saveRun(pi, ctx, run);
  }
}

function uncredited(run: SubagentRun, total: number) {
  return Math.max(0, total - (run.legacyCredits ?? 0));
}

function sourceCheckpoint(run: SubagentRun, ctx: ExtensionContext, checkpoint?: UsageCheckpoint) {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "piop-subagent-usage" || !Check(usageCheckpointSchema, entry.data) || !sameRun(entry.data, run)) continue;
    run.sourceTotals = { ...run.sourceTotals, ...entry.data.sourceTotals };
  }

  if (!checkpoint || checkpoint.total <= (run.sourceTotals?.[checkpoint.sourceId] ?? 0)) return false;
  run.sourceTotals = { ...run.sourceTotals, [checkpoint.sourceId]: checkpoint.total };

  return true;
}

async function accountTranscript(run: SubagentRun, observation: Observation, terminal: boolean, checkpoint?: UsageCheckpoint) {
  const { pi, ctx, signal } = observation;

  if (!terminal) signal.throwIfAborted();
  const usage = await transcriptUsage(run);

  if (!terminal) signal.throwIfAborted();
  const previous = accountedTokens(run, ctx);
  const total = Math.max(previous, usage.tokens);
  const sources = run.sourceTotals;
  const received = sourceCheckpoint(run, ctx, checkpoint);
  const changed = run.apiCost !== usage.apiCost || run.accountedTokens !== total;
  run.apiCost = usage.apiCost;

  try {
    if (total > previous || received) pi.appendEntry("piop-subagent-usage", { tokens: total - previous, total, runId: run.runId, parentSessionId: run.parentSessionId, sessionId: run.sessionId, goalId: run.goalId, sourceTotals: run.sourceTotals });
  } catch (error) { run.sourceTotals = sources; throw error; }

  run.accountedTokens = total;

  if (changed || received) saveRun(pi, ctx, run);
  await settleAccounting(run, observation);
}

function accounting(run: SubagentRun, observation: Observation) {
  let pending = Promise.resolve();

  return (terminal = false, checkpoint?: UsageCheckpoint) => {
    const next = pending.then(() => accountTranscript(run, observation, terminal, checkpoint));
    pending = next.catch(() => undefined);

    return next;
  };
}

const contentSchema = Schema.Union([Schema.String(), Schema.Array(Schema.Unknown())]);

function contentText(content: Static<typeof contentSchema>) {
  if (Check(Schema.String(), content)) return content;

  return Array.isArray(content) ? content.flatMap(part => Check(textSchema, part) ? [part.text] : []).join("\n") : "";
}

function taskObserved(run: SubagentRun, branch: ReturnType<typeof branchEntries>) {
  return branch.findLastIndex(entry => {
    const message = entry.type === "message" ? entry.message : entry;

    if (message?.customType !== "piop-agent-message") return false;

    if (run.taskNotificationId) return Check(Schema.Object({ notificationId: Schema.Literal(run.taskNotificationId) }), message.details);

    if (!Check(contentSchema, message.content)) return false;
    const content = taskContent(message.content);

    return Check(taskMessageSchema, content) && content.sourceSessionId === run.parentSessionId && content.message === run.task && Date.parse(String(entry.timestamp)) >= (run.taskStartedAt ?? run.startedAt);
  });
}

function taskContent(content: Static<typeof contentSchema>) {
  try { return JSON.parse(contentText(content)); }
  catch { return undefined; }
}

export function acceptedSubmission(run: SubagentRun, receipt: Static<typeof subagentReceiptSchema>) {
  run.submission = "accepted";
  run.taskNotificationId = receipt.notificationId;
}

function completedResponse(run: SubagentRun, snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const branch = branchEntries(snapshot);
  const boundary = taskObserved(run, branch);

  if (boundary < 0) return;
  const last = branch.slice(boundary + 1).findLast(entry => entry.type === "message" && Check(assistantSchema, entry.message));

  if (!last || !Check(assistantSchema, last.message) || last.message.stopReason === "toolUse") return;

  return last.message;
}

function finish(run: SubagentRun, last: Static<typeof assistantSchema>) {
  run.status = ["error", "aborted"].includes(last.stopReason) ? "failed" : "completed";
  const text = last.content.flatMap(part => Check(textSchema, part) ? [part.text] : []).join("\n");
  const output = run.status === "failed" ? last.errorMessage || `Subagent ${last.stopReason}` : text || "(No text returned; inspect the saved transcript.)";
  run.output = output.length > 16_000 ? `${output.slice(0, 16_000)}\n[Result truncated. Full conversation is saved in the child transcript.]` : output;
  prepareResult(run);
}

function prepareResult(run: SubagentRun) {
  run.endedAt ??= Date.now();
  run.resultNotificationId ??= `subagent:${run.parentSessionId}:${run.runId ?? `${run.toolCallId}:${run.startedAt}`}`;
  run.resultDelivery ??= "pending";
}

export function finishRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  prepareResult(run);
  saveRun(pi, ctx, run);
}

async function confirmCancellation(run: SubagentRun, signal?: AbortSignal) {
  const ids = run.deliveryIds?.length ? run.deliveryIds : [undefined];

  for (const deliveryId of ids) await interruptSession(run.sessionId, run.hostId, signal, deliveryId);
  run.status = "cancelled";
  run.output = run.cancelReason ?? "Subagent cancellation confirmed";
  prepareResult(run);
}

function interrupted(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun, error: string) {
  if (run.observation === "interrupted" || run.status !== "running") return;
  run.observation = "interrupted";
  saveRun(pi, ctx, run);
  ctx.ui.notify(`Supervision interrupted for ${run.name}; retaining its slot and retrying: ${error}`, "error");
}

class SubagentObserver {
  private closeUsage: (() => Promise<void>) | undefined;
  private channelPath: string | undefined;
  private failures = 0;
  private polled = false;
  private account: ReturnType<typeof accounting>;

  constructor(private run: SubagentRun, private observation: Observation, private lifecycle: ActiveSubagent) {
    this.account = accounting(run, observation);
  }

  private interrupted(error: string) {
    interrupted(this.observation.pi, this.observation.ctx, this.run, error);
  }

  private save() { saveRun(this.observation.pi, this.observation.ctx, this.run); }

  private async channel() {
    if (this.channelPath === this.run.sessionPath) return;
    await this.closeUsage?.();
    this.closeUsage = undefined;
    this.channelPath = undefined;
    this.closeUsage = await listenSubagentUsage(this.run.sessionPath, (total, sourceId) => this.account(false, sourceId ? { sourceId, total } : undefined), error => this.interrupted(String(error)));
    this.channelPath = this.run.sessionPath;
  }

  async submit() {
    const { pi, ctx, signal } = this.observation;
    this.run.offset = (await stat(this.run.sessionPath)).size;
    const scope: GoalScope = { ctx };
    pi.events.emit("piop:goal-scope", scope);
    await scope.ready;
    this.run.goalId = scope.goalId;
    this.save();
    await this.channel();
    signal.throwIfAborted();
    const deliveryId = randomUUID();
    this.lifecycle.deliveryIds.add(deliveryId);
    this.run.deliveryIds = [...this.lifecycle.deliveryIds];
    this.run.submission = "submitted";
    this.save();

    try {
      const receipt = await sendSessionMessage(ctx, this.run.sessionId, this.run.hostId, this.run.task, true, undefined, deliveryId);
      acceptedSubmission(this.run, Parse(subagentReceiptSchema, receipt));
      this.save();
    } catch (error) { this.interrupted(String(error)); }
  }

  private async cancellation() {
    try { await confirmCancellation(this.run); }
    catch (error) { this.interrupted(String(error)); await delay(2000); }
  }

  private async poll() {
    const revision = this.lifecycle.revision;
    const snapshot = await sessionSnapshot(this.run.sessionId, this.run.hostId, this.observation.signal);

    if (snapshot.state.sessionFile) this.run.sessionPath = snapshot.state.sessionFile;

    if (this.run.offset === undefined) await initializeLegacy(this.run, this.observation, snapshot);

    await this.channel();
    await this.account();
    this.failures = 0;

    if (this.run.observation !== "watching") { this.run.observation = "watching"; this.save(); }

    if (!this.canFinish(snapshot, revision)) return;
    const last = completedResponse(this.run, snapshot);

    if (last) { this.lifecycle.closing = true; finish(this.run, last); }
  }

  private canFinish(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>, revision: number) {
    return snapshotStatus(snapshot) === "idle" && revision === this.lifecycle.revision && !this.lifecycle.pendingDeliveries && !this.run.cancelRequested && !this.observation.signal.aborted;
  }

  async watch() {
    this.lifecycle.started();
    const signal = this.observation.signal;

    while (this.run.status === "running") {
      if (signal.aborted && !this.lifecycle.controller.signal.aborted) signal.throwIfAborted();

      if (this.run.cancelRequested) { await this.cancellation(); continue; }

      signal.throwIfAborted();

      if (this.polled && Date.now() >= this.run.startedAt + 600_000) {
        this.run.cancelRequested = true;
        this.run.cancelReason = "Subagent timed out after ten minutes";
        this.save();
        continue;
      }

      try { await this.poll(); }
      catch (error) { this.interrupted(String(error)); this.failures++; }

      this.polled = true;

      await delay(500 * 2 ** Math.min(this.failures, 4), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  }

  failed(dispatch: boolean, error: string) {
    if (dispatch && this.run.submission === "prepared") {
      this.run.status = this.run.cancelRequested ? "cancelled" : "failed";
      this.run.output = this.run.cancelReason ?? error;
      prepareResult(this.run);
    } else this.interrupted(error);
  }

  async close() {
    await this.closeUsage?.();

    if (this.run.status !== "running" && this.run.offset !== undefined) await this.account(true);
  }
}

export async function observeSubagent(run: SubagentRun, observation: Observation, lifecycle: ActiveSubagent, dispatch: boolean) {
  const observer = new SubagentObserver(run, observation, lifecycle);

  try {
    if (dispatch) await observer.submit();
    await observer.watch();
  } catch (error) { observer.failed(dispatch, String(error)); }
  finally { await observer.close(); }
}
