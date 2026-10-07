import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_ENTRY = "piop-goal";

export const GOAL_CONTEXT = "piop-goal-context";

const statusSchema = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("blocked"), Type.Literal("usage_limited"), Type.Literal("budget_limited"), Type.Literal("complete")]);

export type GoalStatus = Static<typeof statusSchema>;

export const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"];

const accountingSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const subagentUsageSchema = Type.Object({
  version: Type.Literal(1), runId: Type.String(), total: accountingSchema, tokens: accountingSchema,
  goalId: Type.Optional(Type.String()),
});

const goalSchema = Type.Object({
  version: Type.Literal(1), id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }),
  objective: Type.String(), status: statusSchema, tokenBudget: Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })]),
  tokensUsed: accountingSchema, elapsedMs: accountingSchema, createdAt: accountingSchema, updatedAt: accountingSchema,
  subagentUsage: Type.Optional(Type.Array(Type.Object({ runId: Type.String(), total: accountingSchema }))),
});

export type Goal = Static<typeof goalSchema>;

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
  const receipts = goal.subagentUsage ??= [];
  const previous = receipts.find(receipt => receipt.runId === usage.runId);
  const accounted = previous?.total ?? Math.max(0, usage.total - usage.tokens);

  if (usage.total <= accounted) return false;
  goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.tokensUsed + usage.total - accounted);

  if (previous) previous.total = usage.total;
  else receipts.push({ runId: usage.runId, total: usage.total });

  return true;
}

export class GoalState {
  goal: Goal | null = null;
  private clock: number | undefined;
  private accountingGoalId: string | undefined;
  private saved = "";
  constructor(private pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext) {
    this.clock = undefined;
    this.accountingGoalId = undefined;
    const entry = [...ctx.sessionManager.getEntries()].reverse().find(item => item.type === "custom" && item.customType === GOAL_ENTRY);
    const data = entry?.type === "custom" ? entry.data : null;

    if (data !== null && !Check(goalSchema, data)) throw new Error("Invalid saved goal");
    this.goal = validateSaved(data);
    this.saved = JSON.stringify(this.goal);
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
    const now = Date.now();
    this.goal = { version: 1, id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), objective: validateObjective(objective), status: "active", tokenBudget: validateBudget(tokenBudget), tokensUsed: 0, elapsedMs: 0, createdAt: now, updatedAt: now };
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
      if (this.goal) this.goal.updatedAt = Date.now();
      this.pi.appendEntry(GOAL_ENTRY, this.goal && structuredClone(this.goal));
      this.saved = JSON.stringify(this.goal);
    }

    this.publish(ctx);
  }

  publish(ctx: ExtensionContext) {
    const goal = this.goal;
    ctx.ui.setWidget(GOAL_ENTRY, undefined);
    ctx.ui.setStatus(GOAL_ENTRY, goal ? JSON.stringify(goal) : undefined);
  }
}
