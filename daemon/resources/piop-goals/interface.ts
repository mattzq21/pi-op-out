import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export type GoalView = {
  id: string; sessionId: string; objective: string; status: GoalStatus;
  /** null means no limit. */
  tokenBudget: number | null;
  tokensUsed: number; elapsedMs: number; timeUsedSeconds: number;
};

/** The current goal and its usage. remainingTokens is null when the goal has no budget. */
export type GoalReport = { goal: GoalView | null; remainingTokens: number | null; completionBudgetReport: string | null };

/** Cumulative usage of one subagent run. total only increases; a repeated total changes nothing. */
export type SubagentGoalUsage = { goalId: string; sourceId: string; total: number };

/**
 * One instance per Pi session. Every method takes the context of the session it acts on and fails when the
 * conversation changed before the operation could run. Operations run one at a time in receipt order.
 * User operations save before they resolve and reject on failure without changing the goal.
 */
export interface GoalSession {
  /** Current goal. */
  report(ctx: ExtensionContext): Promise<GoalReport>;
  /** User request: the goal becomes paused. A budget-limited goal stays budget-limited. Rejects when there is no goal. */
  pause(ctx: ExtensionContext): Promise<GoalReport>;
  /** User request: the goal becomes active and work starts when Pi is idle. Rejects when there is no goal or the goal tools are disabled. */
  resume(ctx: ExtensionContext): Promise<GoalReport>;
  /** User request: deletes the goal. */
  clear(ctx: ExtensionContext): Promise<GoalReport>;
  /** User request: sets the token budget; null removes the limit. Rejects when there is no goal or the budget is not a positive safe integer. */
  setBudget(ctx: ExtensionContext, budget: number | null): Promise<GoalReport>;

  /** The session run was paused or stopped: an active goal becomes paused. Does nothing for other goals. */
  pauseWithSession(ctx: ExtensionContext): Promise<void>;
  /**
   * The paused session run is about to resume: a paused, blocked, usage-limited or budget-limited goal becomes active
   * when the goal tools are enabled. Does not start a turn. Rejects when the token budget is used up.
   */
  resumeWithSession(ctx: ExtensionContext): Promise<void>;

  /** Goal that new usage counts against, or undefined. */
  usageGoalId(ctx: ExtensionContext): Promise<string | undefined>;
  /** Counts the increase of a subagent run's cumulative usage against goalId when it is still the current goal. */
  addSubagentUsage(ctx: ExtensionContext, usage: SubagentGoalUsage): Promise<void>;
  /** Counts subagent usage saved in this conversation's history that the goal has not counted yet. */
  replaySubagentUsage(ctx: ExtensionContext): Promise<void>;
}

/** Other extensions emit this request on "piop:goals:session" to get the session interface. */
export interface GoalSessionRequest { session?: GoalSession }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:goals:session", handler: (request: GoalSessionRequest) => void): () => void;
    emit(channel: "piop:goals:session", request: GoalSessionRequest): void;
  }
}

/** The goals extension's session interface, or undefined when the extension is not loaded. */
export function goalSession(pi: ExtensionAPI): GoalSession | undefined {
  const request: GoalSessionRequest = {};
  pi.events.emit("piop:goals:session", request);

  return request.session;
}

type Usage = { input?: number; output?: number; cacheWrite?: number };

const amount = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

/** Tokens a model response or compaction counts against a goal budget. */
export const goalTokens = (usage?: Usage) => Math.ceil(amount(usage?.input) + amount(usage?.cacheWrite) + amount(usage?.output));
