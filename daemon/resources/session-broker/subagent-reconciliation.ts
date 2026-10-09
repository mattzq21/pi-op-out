import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GoalScope, GoalUsage } from "./goals.ts";
import { listenSubagentUsage, type UsageCheckpoint } from "./subagent-usage.ts";
import { branchEntries, interruptSession, sendSessionMessage, sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { originalRunTask, saveRun, type SubagentRun } from "./subagent-state.ts";
import { transcriptLines, transcriptMetadata, transcriptUsage } from "./subagent-transcript.ts";
import { accountingUnresolved, reportedSubagentUsage, savedSubagentRuns, syncSubagentTranscript, unresolvedSubagentRuns } from "./subagent-results.ts";
import { resultNotificationId } from "./subagent-identity.ts";
import { boundedRecovery, recoverDescendantAccounting, recoverStoppedRun, waitForAccounting, type RecoveryScope } from "./subagent-recovery.ts";
import { activeConversation } from "./conversation-location.ts";

const assistantSchema = Schema.Object({ role: Schema.Literal("assistant"), stopReason: Schema.String(), errorMessage: Schema.Optional(Schema.String()), content: Schema.Array(Schema.Unknown()), piopSubagentUsageId: Schema.Optional(Schema.String()) });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

const usageCheckpointSchema = Schema.Object({ runId: Schema.String(), sourceRunId: Schema.Optional(Schema.String()), parentSessionId: Schema.String(), sessionId: Schema.String(), total: Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), accountedTotal: Schema.Optional(Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), sourceTotals: Schema.Optional(Schema.Record(Schema.String(), Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))) });

export const subagentReceiptSchema = Schema.Object({ accepted: Schema.Literal(true), notificationId: Schema.String() });

const taskMessageSchema = Schema.Object({ sourceSessionId: Schema.String(), message: Schema.String() });

export type ActiveSubagent = {
  controller: AbortController; done: Promise<void>; ready: Promise<void>; started: () => void; closing: boolean;
  revision: number; pendingDeliveries: number; deliveryIds: Set<string>; run?: SubagentRun;
};

export class SubagentCancellation extends Error {}

export type Observation = RecoveryScope & {
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

async function legacyOffset(run: SubagentRun, snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const branch = branchEntries(snapshot);
  const index = taskObserved(run, branch);

  if (!run.usageBoundaryId && index < 0) throw new Error("Cannot identify this run's submitted task on the child's selected branch");
  const id = run.usageBoundaryId ?? branch[index].id;
  let offset: number | undefined;

  for await (const { line, next } of transcriptLines(run.sessionPath, 0, run.sessionId)) {
    let entry;

    try { entry = JSON.parse(line); } catch { continue; }

    if (Check(Schema.Object({ id: Schema.Literal(id) }), entry)) offset = next;
  }

  if (offset === undefined) throw new Error("The child transcript no longer contains the observed task boundary");

  return offset;
}

async function prepareOffset(run: SubagentRun, observation: Observation, snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  seedRecordedUsage(run, observation.ctx);
  const metadata = await transcriptMetadata(run.sessionPath, run.sessionId);
  const initial = { ...run, task: originalRunTask(observation.ctx, run), taskNotificationId: run.usageNotificationId, taskStartedAt: run.startedAt };
  const branch = branchEntries(snapshot);
  const boundary = taskObserved(initial, branch, true);
  const previous = run.usageBoundaryId;

  if (boundary >= 0) run.usageBoundaryId ??= branch[boundary].id;

  if (run.offset === undefined) {
    run.offsetHeader = metadata.header;
    await initializeLegacy(run, observation, snapshot, initial);
  }
  else if (run.offsetHeader !== metadata.header || run.offset > metadata.size) run.offset = await legacyOffset({ ...initial, usageBoundaryId: run.usageBoundaryId }, snapshot);

  if (run.offsetHeader !== metadata.header || previous !== run.usageBoundaryId) {
    run.offsetHeader = metadata.header;
    saveRun(observation.pi, observation.ctx, run);
  }
}

function seedRecordedUsage(run: SubagentRun, ctx: ExtensionContext) {
  if (run.legacyCredits !== undefined) return;
  const credits = reportedSubagentUsage(ctx, run);

  if (!credits) return;
  run.legacyCredits = credits;
  run.accountedTokens = Math.max(run.accountedTokens ?? 0, credits);
  run.goalTokens = Math.max(run.goalTokens ?? 0, credits);
  run.forwardedTokens = Math.max(run.forwardedTokens ?? 0, credits);
}

async function initializeLegacy(run: SubagentRun, observation: Observation, snapshot: Awaited<ReturnType<typeof sessionSnapshot>>, initial: SubagentRun) {
  run.offset = await legacyOffset({ ...initial, usageBoundaryId: run.usageBoundaryId }, snapshot);
  const usage = await transcriptUsage(run);
  const credits = usage.tokens;
  run.legacyCredits = credits;
  run.accountedTokens = credits;
  run.goalTokens = credits;
  run.forwardedTokens = credits;
  saveRun(observation.pi, observation.ctx, run);
}

function accountedTokens(run: SubagentRun, ctx: ExtensionContext) {
  let total = run.accountedTokens ?? 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "piop-subagent-usage" && Check(usageCheckpointSchema, entry.data) && sameRun(entry.data, run)) total = Math.max(total, entry.data.accountedTotal ?? entry.data.total);
  }

  return total;
}

function sameRun(checkpoint: Static<typeof usageCheckpointSchema>, run: SubagentRun) {
  return (checkpoint.sourceRunId ?? checkpoint.runId) === run.runId && checkpoint.parentSessionId === run.parentSessionId && checkpoint.sessionId === run.sessionId;
}

export async function settleAccounting(run: SubagentRun, observation: Observation) {
  const { pi, ctx } = observation;
  observation.signal.throwIfAborted();
  const replay: GoalUsage = { ctx };
  pi.events.emit("piop:goal-usage", replay);
  await replay.ready;
  const total = accountedTokens(run, ctx);
  const sourceId = usageSourceId(run);

  if (run.goalId && total > (run.goalTokens ?? 0)) {
    const event: GoalUsage = { goalId: run.goalId, tokens: total - (run.goalTokens ?? 0), ctx, sourceId, total: uncredited(run, total) };
    pi.events.emit("piop:goal-usage", event);

    if (!event.ready) throw new Error("Cumulative subagent goal accounting is unavailable");
    await event.ready;
    run.goalTokens = total;
    saveRun(pi, ctx, run);
  }

  if (total > (run.forwardedTokens ?? 0)) {
    if (!observation.recoveryDepth) await observation.reportDescendants(total - (run.forwardedTokens ?? 0), ctx, { sourceId, total: uncredited(run, total) });
    run.forwardedTokens = total;
    saveRun(pi, ctx, run);
  }
}

function uncredited(run: SubagentRun, total: number) {
  return Math.max(0, total - (run.legacyCredits ?? 0));
}

function usageSourceId(run: SubagentRun) {
  return JSON.stringify([run.parentSessionId, run.sessionId, run.runId]);
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
    if (total > previous || received) {
      pi.appendEntry("piop-subagent-usage", { version: 1, tokens: total - previous, total: uncredited(run, total), accountedTotal: total, runId: usageSourceId(run), sourceRunId: run.runId, parentSessionId: run.parentSessionId, sessionId: run.sessionId, goalId: run.goalId, sourceTotals: run.sourceTotals });
      await syncSubagentTranscript(ctx);
    }
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

function taskObserved(run: SubagentRun, branch: ReturnType<typeof branchEntries>, first = false) {
  const matches = (entry: ReturnType<typeof branchEntries>[number]) => {
    const message = entry.type === "message" ? entry.message : entry;

    if (message?.customType !== "piop-agent-message") return false;

    if (run.taskNotificationId) return Check(Schema.Object({ notificationId: Schema.Literal(run.taskNotificationId) }), message.details);

    if (!Check(contentSchema, message.content)) return false;
    const content = taskContent(message.content);

    return Check(taskMessageSchema, content) && content.sourceSessionId === run.parentSessionId && content.message === run.task && Date.parse(String(entry.timestamp)) >= (run.taskStartedAt ?? run.startedAt);
  };

  return first ? branch.findIndex(matches) : branch.findLastIndex(matches);
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
    this.closeUsage = await listenSubagentUsage(this.run.sessionPath, this.run.sessionId, (total, sourceId) => this.account(false, sourceId ? { sourceId, total } : undefined), error => this.interrupted(String(error)), this.run);
    this.channelPath = this.run.sessionPath;
  }

  async submit() {
    const { pi, ctx, signal } = this.observation;
    this.run.accountingPending = true;
    const location = await activeConversation(this.run.sessionId, this.run.hostId, signal);
    this.run.sessionPath = location.sessionPath;
    const metadata = await transcriptMetadata(this.run.sessionPath, this.run.sessionId);
    this.run.offset = metadata.size;
    this.run.offsetHeader = metadata.header;
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
      this.run.usageNotificationId = this.run.taskNotificationId;
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

    await prepareOffset(this.run, this.observation, snapshot);

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
      this.run.accountingPending = false;
      prepareResult(this.run);
    } else this.interrupted(error);
  }

  async close() {
    let failure;

    try { await this.closeUsage?.(); } catch (error) { failure = error; }

    if (this.run.status !== "running" && this.run.accountingPending) await reconcileFinalAccounting(this.run, { ...this.observation, ...boundedRecovery({ signal: undefined }) });

    if (failure) throw failure;
  }
}

async function requireDescendants(run: SubagentRun, scope: RecoveryScope) {
  await recoverDescendantAccounting(run, scope);

  if ((await unresolvedSubagentRuns(run.sessionPath, run.sessionId)).length) throw new Error(`Token usage for descendants of ${run.name} remains pending`);
}

async function reconcileFinalAccounting(run: SubagentRun, observation: Observation) {
  const snapshot = await sessionSnapshot(run.sessionId, run.hostId, observation.signal);

  if (snapshot.state.sessionFile) run.sessionPath = snapshot.state.sessionFile;
  await requireDescendants(run, observation);
  await prepareOffset(run, observation, snapshot);
  await accountTranscript(run, observation, false);
  await requireDescendants(run, observation);
  observation.signal.throwIfAborted();
  run.accountingPending = false;
  saveRun(observation.pi, observation.ctx, run);
}

const accountingRecoveries = new Map<string, { run: SubagentRun; done: Promise<void> }>();

export async function recoverSubagentAccounting(run: SubagentRun, observation: Observation) {
  observation.signal.throwIfAborted();
  const key = resultNotificationId(run);
  let recovery = accountingRecoveries.get(key);

  if (!recovery) {
    recovery = { run, done: performRecovery(run, observation).finally(() => { accountingRecoveries.delete(key); }) };
    accountingRecoveries.set(key, recovery);
  }

  await waitForAccounting(recovery.done, boundedRecovery(observation));
  Object.assign(run, recovery.run);
}

async function performRecovery(run: SubagentRun, observation: Observation) {
  const latest = (await savedSubagentRuns(observation.ctx)).find(saved => resultNotificationId(saved) === resultNotificationId(run));

  if (latest) Object.assign(run, latest);

  if (!accountingUnresolved(run)) return;
  const scope = boundedRecovery(observation);
  run.runId ??= `${run.toolCallId}:${run.startedAt}`;
  await recoverStoppedRun(observation.pi, observation.ctx, run, scope);
  await reconcileFinalAccounting(run, { ...observation, ...scope });
}

export async function drainAccountingRecovery() {
  await Promise.allSettled([...accountingRecoveries.values()].map(recovery => recovery.done));
}

export async function observeSubagent(run: SubagentRun, observation: Observation, lifecycle: ActiveSubagent, dispatch: boolean) {
  const observer = new SubagentObserver(run, observation, lifecycle);

  try {
    if (dispatch) await observer.submit();
    await observer.watch();
  } catch (error) { observer.failed(dispatch, String(error)); }
  finally { await observer.close(); }
}
