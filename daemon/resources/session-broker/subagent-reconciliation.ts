import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { branchEntries, interruptSession, sendSessionMessage, sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { saveRun, type SubagentRun } from "./subagent-state.ts";

/** How long one subagent run may take before it is stopped. */
const SUBAGENT_RUN_LIMIT_MS = 60 * 60_000;

/** How often the time a run has been watched is saved, so a restart loses at most this much of it. */
const ACTIVE_TIME_SAVE_MS = 30_000;
import { activeConversation } from "./conversation-location.ts";

const assistantSchema = Schema.Object({ role: Schema.Literal("assistant"), stopReason: Schema.String(), errorMessage: Schema.Optional(Schema.String()), content: Schema.Array(Schema.Unknown()) });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

export const subagentReceiptSchema = Schema.Object({ accepted: Schema.Literal(true), notificationId: Schema.String() });

const taskMessageSchema = Schema.Object({ sourceSessionId: Schema.String(), message: Schema.String() });

export type ActiveSubagent = {
  controller: AbortController; done: Promise<void>; ready: Promise<void>; started: () => void; closing: boolean;
  revision: number; pendingDeliveries: number; deliveryIds: Set<string>; run?: SubagentRun;
};

export class SubagentCancellation extends Error {}

export type Observation = {
  pi: ExtensionAPI; ctx: ExtensionContext; signal: AbortSignal;
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

const contentSchema = Schema.Union([Schema.String(), Schema.Array(Schema.Unknown())]);

function contentText(content: Static<typeof contentSchema>) {
  if (Check(Schema.String(), content)) return content;

  return Array.isArray(content) ? content.flatMap(part => Check(textSchema, part) ? [part.text] : []).join("\n") : "";
}

function taskObserved(run: SubagentRun, branch: ReturnType<typeof branchEntries>) {
  const matches = (entry: ReturnType<typeof branchEntries>[number]) => {
    const message = entry.type === "message" ? entry.message : entry;

    if (message?.customType !== "piop-agent-message") return false;

    if (run.taskNotificationId) return Check(Schema.Object({ notificationId: Schema.Literal(run.taskNotificationId) }), message.details);

    if (!Check(contentSchema, message.content)) return false;
    const content = taskContent(message.content);

    return Check(taskMessageSchema, content) && content.sourceSessionId === run.parentSessionId && content.message === run.task && Date.parse(String(entry.timestamp)) >= (run.taskStartedAt ?? run.startedAt);
  };

  return branch.findLastIndex(matches);
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
  run.output = output.length > 16_000 ? `${output.slice(0, 16_000)}\n[Answer truncated.]` : output;
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
  private failures = 0;
  private polled = false;
  private lastTick = performance.now();
  private lastSaved = performance.now();

  constructor(private run: SubagentRun, private observation: Observation, private lifecycle: ActiveSubagent) {}

  private interrupted(error: string) {
    interrupted(this.observation.pi, this.observation.ctx, this.run, error);
  }

  private save() { saveRun(this.observation.pi, this.observation.ctx, this.run); }

  /**
   * Adds the time since the last tick to the run's active time. Only time while Piop watches the run counts,
   * so time while Piop was not running is left out. message_subagent sets the active time back to zero.
   */
  private tick() {
    const now = performance.now();
    this.run.activeMs = (this.run.activeMs ?? 0) + (now - this.lastTick);
    this.lastTick = now;

    if (now - this.lastSaved >= ACTIVE_TIME_SAVE_MS) { this.lastSaved = now; this.save(); }
  }

  private remaining() { return SUBAGENT_RUN_LIMIT_MS - (this.run.activeMs ?? 0); }

  async submit() {
    const { signal } = this.observation;
    const location = await activeConversation(this.run.sessionId, this.run.hostId, signal);
    this.run.sessionPath = location.sessionPath;
    this.save();
    signal.throwIfAborted();
    const deliveryId = randomUUID();
    this.lifecycle.deliveryIds.add(deliveryId);
    this.run.deliveryIds = [...this.lifecycle.deliveryIds];
    this.run.submission = "submitted";
    this.save();

    try { await this.deliver(); }
    catch (error) { this.interrupted((error instanceof Error ? error.message : String(error))); }
  }

  private async deliver() {
    const deliveryId = this.run.deliveryIds?.at(-1);

    if (!deliveryId) throw new Error("Submitted subagent task has no saved delivery ID");
    const remaining = this.remaining();

    if (remaining <= 0) throw new Error("Subagent task delivery timed out");
    const signal = AbortSignal.any([this.observation.signal, AbortSignal.timeout(remaining)]);
    this.lifecycle.pendingDeliveries++;

    try {
      const receipt = await sendSessionMessage(this.observation.ctx, this.run.sessionId, this.run.hostId, this.run.task, true, signal, deliveryId);
      acceptedSubmission(this.run, Parse(subagentReceiptSchema, receipt));

      this.save();
    } finally { this.lifecycle.pendingDeliveries--; }
  }

  private async cancellation() {
    const signal = AbortSignal.timeout(10_000);

    try {
      while (this.run.status === "running") {
        signal.throwIfAborted();

        try { await confirmCancellation(this.run, signal); }
        catch (error) {
          signal.throwIfAborted();
          this.interrupted((error instanceof Error ? error.message : String(error)));
          await delay(2000, undefined, { signal });
        }
      }
    } catch (error) {
      this.run.observation = "interrupted";
      this.save();
      this.observation.ctx.ui.notify(`Cancellation of ${this.run.name} remains pending; the saved stop will be retried on reconciliation: ${(error instanceof Error ? error.message : String(error))}`, "error");
      throw error;
    }
  }

  private async poll() {
    const revision = this.lifecycle.revision;
    const snapshot = await sessionSnapshot(this.run.sessionId, this.run.hostId, this.observation.signal);

    if (snapshot.state.sessionFile) this.run.sessionPath = snapshot.state.sessionFile;

    this.failures = 0;

    if (this.run.observation !== "watching") { this.run.observation = "watching"; this.save(); }

    if (!this.canFinish(snapshot, revision)) return;
    const last = completedResponse(this.run, snapshot);

    if (last) { this.lifecycle.closing = true; finish(this.run, last); }
  }

  private canFinish(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>, revision: number) {
    const status = snapshotStatus(snapshot);
    // A child that paused after a failed response is reported as failed; it stays paused, so a follow-up can resume it.
    const failedAndPaused = status === "paused" && completedResponse(this.run, snapshot)?.stopReason === "error";

    return (status === "idle" || failedAndPaused) && revision === this.lifecycle.revision && !this.lifecycle.pendingDeliveries && !this.run.cancelRequested && !this.observation.signal.aborted;
  }

  async watch() {
    this.lifecycle.started();
    const signal = this.observation.signal;

    while (this.run.status === "running") {
      if (signal.aborted && !this.lifecycle.controller.signal.aborted) signal.throwIfAborted();

      if (this.run.cancelRequested) { await this.cancellation(); continue; }

      signal.throwIfAborted();

      this.tick();

      if ((this.polled || this.run.submission === "submitted") && this.remaining() <= 0) {
        this.run.cancelRequested = true;
        this.run.cancelReason = "Subagent timed out after 60 minutes";
        this.save();
        continue;
      }

      try {
        if (this.run.submission === "submitted" && !this.lifecycle.pendingDeliveries) await this.deliver();
        await this.poll();
      }
      catch (error) { this.interrupted((error instanceof Error ? error.message : String(error))); this.failures++; }

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
}

export async function observeSubagent(run: SubagentRun, observation: Observation, lifecycle: ActiveSubagent, dispatch: boolean) {
  const observer = new SubagentObserver(run, observation, lifecycle);

  try {
    if (dispatch) await observer.submit();
    await observer.watch();
  } catch (error) { observer.failed(dispatch, (error instanceof Error ? error.message : String(error))); }
}
