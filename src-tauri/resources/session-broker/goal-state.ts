import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_ENTRY = "piop-goal";
export const GOAL_CONTEXT = "piop-goal-context";
export const GOAL_STATUSES = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];
export type Goal = {
  version: 1; id: string; sessionId: string; objective: string; status: GoalStatus;
  tokenBudget: number | null; tokensUsed: number; elapsedMs: number; createdAt: number; updatedAt: number;
};
type Usage = { input?: number; output?: number; cacheWrite?: number };
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
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

function validateSaved(data: unknown): Goal | null {
  if (data === null) return null;
  if (!data || typeof data !== "object") throw new Error("Invalid saved goal");
  const goal = data as Goal;
  if (goal.version !== 1 || !goal.id || !goal.sessionId) throw new Error("Invalid saved goal identity");
  if (!GOAL_STATUSES.includes(goal.status)) throw new Error("Invalid saved goal status");
  validateObjective(goal.objective); validateBudget(goal.tokenBudget);
  validateAccounting(goal);
  return structuredClone(goal);
}

function validateAccounting(goal: Goal) {
  for (const value of [goal.tokensUsed, goal.elapsedMs, goal.createdAt, goal.updatedAt]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid saved goal accounting");
  }
}

export class GoalState {
  goal: Goal | null = null;
  private clock: number | undefined;
  private accountingGoalId: string | undefined;
  private saved = "";
  constructor(private pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext, navigating = false) {
    this.clock = undefined;
    this.accountingGoalId = undefined;
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(item => item.type === "custom" && item.customType === GOAL_ENTRY);
    this.goal = validateSaved(entry?.type === "custom" ? entry.data : null);
    this.saved = JSON.stringify(this.goal);
    if (!this.goal) { this.publish(ctx); return; }
    if (this.goal.sessionId !== ctx.sessionManager.getSessionId()) {
      this.goal.id = randomUUID();
      this.goal.sessionId = ctx.sessionManager.getSessionId();
      navigating = true;
    }
    if (navigating && this.goal.status === "active") this.goal.status = "paused";
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

  response() {
    this.flushClock();
    const goal = this.goal && { ...this.goal, timeUsedSeconds: Math.floor(this.goal.elapsedMs / 1000) };
    return { goal, remainingTokens: goal?.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed) };
  }

  save(ctx: ExtensionContext) {
    const next = JSON.stringify(this.goal);
    if (next !== this.saved) {
      if (this.goal) this.goal.updatedAt = Date.now();
      this.pi.appendEntry(GOAL_ENTRY, this.goal && { ...this.goal });
      this.saved = JSON.stringify(this.goal);
    }
    this.publish(ctx);
  }

  publish(ctx: ExtensionContext) {
    const goal = this.goal;
    const status = goal?.status.replaceAll("_", " ");
    const budget = goal?.tokenBudget == null ? `${goal?.tokensUsed ?? 0} tokens` : `${goal.tokensUsed} / ${goal.tokenBudget} tokens`;
    ctx.ui.setWidget(GOAL_ENTRY, goal ? [`Goal ${status} · ${budget} · ${Math.floor(goal.elapsedMs / 1000)}s`, goal.objective.length > 180 ? `${goal.objective.slice(0, 180)}…` : goal.objective, "/goal · /goal pause · /goal resume · /goal clear"] : undefined);
  }
}
