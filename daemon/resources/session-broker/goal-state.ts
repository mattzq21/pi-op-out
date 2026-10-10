import { acquireSessionReferencePublication, validateSessionReferencePublication } from "../sdk-storage.mjs";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { read, write } from "./goal-storage.cjs";
import { storageRoot } from "../session-database.cjs";

const GOAL_STATUS_KEY = "piop-goal";

export const GOAL_CONTEXT = "piop-goal-context";

const statusSchema = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("blocked"), Type.Literal("usage_limited"), Type.Literal("budget_limited"), Type.Literal("complete")]);

export type GoalStatus = Static<typeof statusSchema>;

export const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"];

const accountingSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const subagentUsageSchema = Type.Object({
  version: Type.Literal(1), runId: Type.String(), total: accountingSchema, tokens: accountingSchema,
  goalId: Type.Optional(Type.String()), sourceRunId: Type.Optional(Type.String()), accountedTotal: Type.Optional(accountingSchema),
});

const goalSchema = Type.Object({
  id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }),
  objective: Type.String(), status: statusSchema, tokenBudget: Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })]),
  tokensUsed: accountingSchema, elapsedMs: accountingSchema,
  subagentUsage: Type.Optional(Type.Record(Type.String(), accountingSchema)),
});

export type Goal = Static<typeof goalSchema>;

function subagentConsumed(goal: Goal, sourceId: string) {
  const receipts = goal.subagentUsage;

  return receipts && Object.hasOwn(receipts, sourceId) ? receipts[sourceId] : undefined;
}

function saveSubagentReceipt(goal: Goal, sourceId: string, total: number) {
  const receipts = goal.subagentUsage;
  goal.subagentUsage = { ...receipts, [sourceId]: total };
}

type Usage = { input?: number; output?: number; cacheWrite?: number };

const amount = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

export const goalTokens = (usage?: Usage) => Math.ceil(amount(usage?.input) + amount(usage?.cacheWrite) + amount(usage?.output));

export function validateObjective(value: string) {
  const objective = value.trim();

  if (!objective || [...objective].length > 4000) throw new Error("Goal objective must contain 1–4,000 characters. Reference a file for longer instructions.");

  return objective;
}

export function validateBudget(value: number | null) {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("Token budget must be a positive safe integer, or null for no limit.");

  return value;
}

function validateSaved(data: Goal | null): Goal | null {
  if (data === null) return null;
  validateObjective(data.objective);

  return structuredClone(data);
}

function applySubagentUsage(goal: Goal, usage: Static<typeof subagentUsageSchema>) {
  if (usage.goalId !== goal.id) return false;
  const baseline = usage.sourceRunId !== undefined && usage.accountedTotal !== undefined ? 0 : Math.max(0, usage.total - usage.tokens);
  const accounted = subagentConsumed(goal, usage.runId) ?? baseline;

  if (usage.total <= accounted) return false;
  goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.tokensUsed + usage.total - accounted);

  saveSubagentReceipt(goal, usage.runId, usage.total);

  return true;
}

export class GoalState {
  goal: Goal | null = null;
  private clock: number | undefined;
  private accountingGoalId: string | undefined;
  private saved = "";

  restore(ctx: ExtensionContext) {
    this.clock = undefined;
    this.accountingGoalId = undefined;
    const file = ctx.sessionManager.getSessionFile();
    const data = file ? read(storageRoot(file), ctx.sessionManager.getSessionId()) : null;

    if (data !== null && !Check(goalSchema, data)) throw new Error("Invalid saved goal");
    this.goal = validateSaved(data);
    this.saved = JSON.stringify(this.goal);
    this.enforceBudget(true);
    this.save(ctx);
    this.replaySubagentUsage(ctx);

    if (this.goal?.status === "complete") { this.clear(ctx);

    return; }

    if (!this.goal) { this.publish(ctx);

    return; }

    if (this.goal.sessionId !== ctx.sessionManager.getSessionId()) {
      this.goal.sessionId = ctx.sessionManager.getSessionId();
    }

    this.save(ctx);
  }

  create(ctx: ExtensionContext, objective: string, tokenBudget: number | null) {
    if (this.goal && this.goal.status !== "complete") throw new Error("This conversation has an unfinished goal. Use /goal edit or /goal clear first.");
    this.goal = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), objective: validateObjective(objective), status: "active", tokenBudget: validateBudget(tokenBudget), tokensUsed: 0, elapsedMs: 0 };
    this.clock = ctx.isIdle() ? undefined : performance.now();
    this.accountingGoalId = ctx.isIdle() ? undefined : this.goal.id;
    this.save(ctx);
  }

  beginRun() {
    if (this.goal?.status === "active") this.accountingGoalId = this.goal.id;
    else if (this.accountingGoalId !== this.goal?.id) this.accountingGoalId = undefined;
    this.startClock();
  }

  finishRun() {
    this.flushClock(true);
    this.accountingGoalId = undefined;
  }

  usageGoalId() {
    if (!this.goal || !["active", "budget_limited"].includes(this.goal.status)) return undefined;

    return this.accountingGoalId === this.goal.id ? this.accountingGoalId : undefined;
  }

  startClock() {
    if (this.usageGoalId() && this.clock === undefined) this.clock = performance.now();
  }

  flushClock(stop = false) {
    if (this.clock === undefined) return;
    const now = performance.now();

    if (this.goal) this.goal.elapsedMs += Math.max(0, Math.floor(now - this.clock));
    this.clock = stop ? undefined : now;
  }

  account(ctx: ExtensionContext, tokens: number, includeStopped = false) {
    if (!this.goal || this.goal.status === "complete") return false;

    if (this.accountingGoalId !== this.goal.id) return false;

    if (!includeStopped && !["active", "budget_limited"].includes(this.goal.status)) return false;
    this.flushClock();
    this.goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, this.goal.tokensUsed + amount(tokens));
    const limited = this.enforceBudget(includeStopped);
    this.save(ctx);

    return limited;
  }

  replaySubagentUsage(ctx: ExtensionContext) {
    if (!this.goal) return false;
    let changed = false;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "piop-subagent-usage" || !Check(subagentUsageSchema, entry.data)) continue;
      changed = applySubagentUsage(this.goal, entry.data) || changed;
    }

    if (changed) this.flushClock();
    const limited = changed && this.enforceBudget(true);
    this.save(ctx);

    return limited;
  }

  accountSubagent(ctx: ExtensionContext, sourceId: string, total: number) {
    if (!this.goal || this.goal.status === "complete") return false;

    if (!sourceId || !Number.isSafeInteger(total) || total < 0) throw new Error("Invalid cumulative subagent usage");
    const previous = structuredClone(this.goal);
    const saved = this.saved;
    const clock = this.clock;
    const consumed = subagentConsumed(this.goal, sourceId) ?? 0;

    if (total <= consumed) return false;
    this.flushClock();
    saveSubagentReceipt(this.goal, sourceId, total);
    this.goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, this.goal.tokensUsed + total - consumed);
    const limited = this.enforceBudget(true);

    try { this.save(ctx); }
    catch (error) {
      if (this.saved === saved) { this.goal = previous; this.clock = clock; }

      throw error;
    }

    return limited;
  }

  enforceBudget(includeStopped = false) {
    const goal = this.goal;

    if (!goal || goal.status === "budget_limited" || goal.status === "complete") return false;

    if (!includeStopped && goal.status !== "active") return false;

    if (goal.tokenBudget === null || goal.tokensUsed < goal.tokenBudget) return false;
    goal.status = "budget_limited";

    return true;
  }

  setStatus(ctx: ExtensionContext, status: GoalStatus) {
    const goal = this.require();
    this.flushClock(status !== "active");

    if (goal.status !== "budget_limited" || !["paused", "blocked"].includes(status)) goal.status = status;
    this.enforceBudget();

    if (!ctx.isIdle()) this.beginRun();
    this.save(ctx);
  }

  clear(ctx: ExtensionContext) {
    this.clock = undefined; this.accountingGoalId = undefined; this.goal = null; this.save(ctx);
  }

  require() {
    if (!this.goal) throw new Error("No goal is set for this conversation.");

    return this.goal;
  }

  response(completed = false) {
    this.flushClock();
    const goal = this.goal && { ...this.goal, timeUsedSeconds: Math.floor(this.goal.elapsedMs / 1000) };
    const completionBudgetReport = completed && goal?.status === "complete" && (goal.tokenBudget !== null || goal.timeUsedSeconds > 0) ? "Goal achieved. Report final usage from this tool result's structured goal fields. If goal.tokenBudget is present, include goal.tokensUsed and goal.tokenBudget. If goal.timeUsedSeconds is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language." : null;

    return { goal, remainingTokens: goal?.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed), completionBudgetReport };
  }

  save(ctx: ExtensionContext) {
    const next = JSON.stringify(this.goal);

    if (next !== this.saved) {
      const file = ctx.sessionManager.getSessionFile();

      if (!file) throw new Error("Save this conversation before setting a goal");
      const release = acquireSessionReferencePublication(file, ctx.sessionManager.getSessionId());

      try {
        validateSessionReferencePublication(this.goal ? [this.goal] : [], []);
        write(storageRoot(file), ctx.sessionManager.getSessionId(), this.goal);
      } finally { release(); }

      this.saved = JSON.stringify(this.goal);
    }

    this.publish(ctx);
  }

  publish(ctx: ExtensionContext) {
    const goal = this.goal;
    ctx.ui.setWidget(GOAL_STATUS_KEY, undefined);
    ctx.ui.setStatus(GOAL_STATUS_KEY, goal ? JSON.stringify(goal) : undefined);
  }
}
