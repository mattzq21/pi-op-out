import { restoreGoalAttachments } from "./files.ts";
import type { ExtensionAPI, ExtensionContext, AgentBeforeSettleEvent, AgentBeforeSettleEventResult, InputEventResult, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { GoalState, GOAL_CONTEXT, validateBudget } from "./state.ts";
import { goalBudgetPrompt, goalChangedPrompt, goalInactivePrompt, goalPrompt } from "./prompts.ts";
import { GoalCoordination } from "./coordination.ts";
import { goalTokens, type GoalSession, type SubagentGoalUsage } from "./interface.ts";
import type { GoalCore } from "./preparation.ts";
import { sessionControls } from "../piop-controls/interface.ts";

interface AgentsReady { ctx: ExtensionContext }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:ready", handler: (event: AgentsReady) => void): () => void;
    emit(channel: "piop:agents:ready", event: AgentsReady): void;
  }
}

function persistent(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  return !!path;
}

function providerErrorStatus(message: string | undefined): "usage_limited" | "blocked" {
  return /usage[_\s-]*limit|rate[_\s-]*limit|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|too many requests|out of budget|monthly usage limit|available balance|\b429\b/i.test(message ?? "") ? "usage_limited" : "blocked";
}

/** Registers goal tracking for the session and publishes its GoalSession. Returns the goal internals for the goal tools and Piop input. */
export function registerGoals(pi: ExtensionAPI): { session: GoalSession; core: GoalCore } {
  const state = new GoalState();

  const pause = (ctx: ExtensionContext) => {
    const controls = sessionControls(pi);

    if (!controls) { ctx.ui.notify("Session controls are unavailable, so the goal could not pause the run.", "error");

    return; }
    void controls.pause(ctx).catch(error => ctx.ui.notify(String(error), "error"));
  };

  const coordination = new GoalCoordination();

  const schedule = (ctx: ExtensionContext, operation: () => void) => {
    void coordination.run(ctx, operation).catch(error => ctx.ui.notify(String(error), "error"));
  };

  let context: ExtensionContext | undefined;
  let starting = false;
  let pendingStart = false;
  let restored = false;
  let restoredSessionId: string | undefined;
  let emptyTurns = 0;
  let failedTurns = 0;
  let activity = false;
  let emptyFinal = false;
  let successfulTool = false;
  let failedTool = false;
  let automatic = false;
  let runGoalId: string | undefined;
  let responseGoalId: string | undefined;
  let runSignal: AbortSignal | undefined;
  let rateLimited = false;
  const resetAudit = () => { emptyTurns = 0; failedTurns = 0; automatic = false; };

  const allowed = () => ["get_goal", "create_goal", "update_goal"].every(name => pi.getActiveTools().includes(name));

  const assertAvailable = (ctx: ExtensionContext) => {
    if (!persistent(ctx)) throw new Error("Goals require a saved conversation.");

    if (!allowed()) throw new Error("Enable get_goal, create_goal and update_goal for this agent under Settings → Agents → Tools before starting a goal.");
  };

  const steering = (content: string) => pi.sendMessage({ customType: GOAL_CONTEXT, content, display: false, details: { goalId: state.goal?.id } }, { triggerTurn: false });

  const account = (ctx: ExtensionContext, tokens: number, includeStopped = false) => {
    if (state.account(ctx, tokens, includeStopped) && state.goal) {
      steering(goalBudgetPrompt(state.goal));
      pause(ctx);
    }
  };

  const start = (ctx: ExtensionContext) => {
    if (starting || state.goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    assertAvailable(ctx);
    starting = true;
    pendingStart = true;
    pi.sendUserMessage("Continue working toward the active conversation goal.", { deliverAs: "followUp" });
  };

  const changed = (ctx: ExtensionContext) => {
    resetAudit(); state.save(ctx);

    if (!ctx.isIdle()) steering(goalChangedPrompt(state.goal));
  };

  const core: GoalCore = { state, coordination, assertAvailable, changed, start };

  const restore = async (ctx: ExtensionContext) => {
    context = ctx; starting = false; pendingStart = false; resetAudit(); runGoalId = undefined;
    rateLimited = false;

    try {
      state.restore(ctx);

      if (!persistent(ctx)) { state.goal = null; state.publish(ctx); }

      if (state.goal) await restoreGoalAttachments(ctx, state.goal.objective);

      restored = true;
      restoredSessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      state.goal = null; state.publish(ctx); restored = false;
      restoredSessionId = undefined;
      ctx.ui.notify(`Could not restore goal: ${String(error)}`, "error");
    }
  };

  pi.on("session_start", (_event, ctx) => coordination.run(ctx, () => restore(ctx)));
  pi.on("session_tree", (_event, ctx) => coordination.run(ctx, () => restore(ctx)));

  const ready = pi.events.on("piop:agents:ready", ({ ctx }) => {
    if (process.env.PIOP_USAGE_RECOVERY === "1") return;
    schedule(ctx, () => {
    if (!restored || state.goal?.status !== "active") return;

    if (!allowed()) { state.setStatus(ctx, "paused");

    return; }

    start(ctx);
    });
  });

  pi.on("input", (event, ctx) => coordination.run(ctx, (): InputEventResult | void => {
    starting = false;

    if (event.source === "extension" && pendingStart && event.text === "Continue working toward the active conversation goal.") {
      pendingStart = false;

      if (state.goal?.status !== "active") return { action: "handled" };
    }

    if (event.source !== "extension") resetAudit();
  }));
  pi.on("agent_start", (_event, ctx) => coordination.run(ctx, () => {
    context = ctx; starting = false;
    runSignal = ctx.signal;
    rateLimited = false;
    activity = false; emptyFinal = false; successfulTool = false; failedTool = false;
    runGoalId = state.goal?.status === "active" ? state.goal.id : undefined;

    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
    state.beginRun();
  }));
  pi.on("message_start", (event, ctx) => coordination.run(ctx, () => {
    if (event.message.role !== "assistant") return;
    responseGoalId = state.usageGoalId();
  }));
  pi.on("message_end", (event, ctx) => coordination.run(ctx, () => {
    if (event.message.role !== "assistant") return;
    const message = event.message;
    activity ||= message.content.some(part => part.type === "toolCall" || (part.type === "text" ? part.text.trim() : part.thinking.trim()));

    if (responseGoalId && responseGoalId === state.goal?.id) account(ctx, goalTokens(message.usage), true);

    if (message.stopReason === "aborted" && state.goal?.status === "active") state.setStatus(ctx, "paused");
  }));
  pi.on("message_end", (event, ctx) => coordination.run(ctx, (): MessageEndEventResult | void => {
    if (event.message.role !== "assistant") return;
    emptyFinal ||= event.message.stopReason === "stop" && !event.message.content.some(part => part.type === "text" && part.text.trim());

    const wasRateLimited = rateLimited;
    rateLimited = false;

    if (event.message.stopReason !== "error" && !wasRateLimited) return;
    const message = wasRateLimited && event.message.stopReason !== "error"
      ? { ...event.message, stopReason: "error" as const, errorMessage: "HTTP 429: Too many requests. The model provider limited this request. Try again later." }
      : event.message;

    try {
      if (state.usageGoalId()) state.setStatus(ctx, wasRateLimited ? "usage_limited" : providerErrorStatus(message.errorMessage));
    } finally { pause(ctx); }

    return { message };
  }));
  pi.on("tool_result", (event, ctx) => coordination.run(ctx, () => {
    activity = true;
    successfulTool ||= !event.isError;
    failedTool ||= event.isError;
    account(ctx, 0);
  }));
  pi.on("session_compact", (event, ctx) => coordination.run(ctx, () => {
    account(ctx, goalTokens(event.compactionEntry.usage));

    if (state.goal?.status === "active") steering(goalPrompt(state.goal));
  }));
  pi.on("session_compact_failed", (event, ctx) => coordination.run(ctx, () => {
    if (event.errorMessage && state.goal?.status === "active") state.setStatus(ctx, "blocked");
  }));
  pi.on("agent_end", (_event, ctx) => coordination.run(ctx, () => { state.flushClock(); state.save(ctx); }));
  pi.on("after_provider_response", (event, ctx) => coordination.run(ctx, () => {
    if (event.status !== 429) return;
    rateLimited = true;

    try {
      if (state.usageGoalId()) state.setStatus(ctx, "usage_limited");
    } finally { pause(ctx); }
  }));

  const stopForOutcome = (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
    if (event.outcome === "completed") return false;

    if (!state.usageGoalId()) return false;

    if (event.outcome === "aborted") state.setStatus(ctx, "paused");
    else state.setStatus(ctx, "blocked");

    return true;
  };

  const stalled = () => {
    emptyTurns = automatic && emptyFinal && !activity ? emptyTurns + 1 : 0;

    if (successfulTool) failedTurns = 0;
    else if (failedTool) failedTurns++;

    return emptyTurns >= 3 || failedTurns >= 5;
  };

  pi.on("agent_before_settle", (event, ctx) => coordination.run(ctx, (): AgentBeforeSettleEventResult | void => {
    if (stopForOutcome(event, ctx)) return;

    if (state.goal?.status !== "active") return;

    if (!allowed()) { state.setStatus(ctx, "paused");

    return; }

    if (runGoalId !== state.goal.id) resetAudit();

    if (stalled()) {
      try { state.setStatus(ctx, "blocked"); }
      finally { pause(ctx); }

      return;
    }

    if (ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
    automatic = true;

    return { continue: true, entries: [{ type: "custom_message", customType: GOAL_CONTEXT, content: goalPrompt(state.goal), display: false, details: { goalId: state.goal.id } }] };
  }));
  pi.on("agent_settled", (_event, ctx) => coordination.run(ctx, () => {
    starting = false; state.finishRun(); responseGoalId = undefined;

    if (state.goal?.status === "active" && runSignal?.aborted) state.setStatus(ctx, "paused");
    state.save(ctx);
  }));

  const cumulativeUsage = (ctx: ExtensionContext, usage: SubagentGoalUsage) => {
    if (!restored || restoredSessionId !== ctx.sessionManager.getSessionId()) restore(ctx);

    if (!restored) throw new Error("Saved goal state is invalid; cumulative subagent usage remains pending");

    if (!usage.goalId || usage.goalId !== state.goal?.id) return;

    if (state.accountSubagent(ctx, usage.sourceId, usage.total) && state.goal) {
      steering(goalBudgetPrompt(state.goal));
      pause(ctx);
    }
  };

  /** Runs a user operation, saves, reports the result, then starts work when the goal is active and Pi is idle. */
  const commit = (ctx: ExtensionContext, operation: () => void, startWork = true) => coordination.run(ctx, () => {
    operation();
    const report = state.response();
    state.save(ctx);

    if (startWork) start(ctx);

    return report;
  });

  const session: GoalSession = {
    report: ctx => commit(ctx, () => undefined, false),
    pause: ctx => commit(ctx, () => { state.setStatus(ctx, "paused"); changed(ctx); }),
    resume: ctx => commit(ctx, () => { assertAvailable(ctx); state.setStatus(ctx, "active"); changed(ctx); }),
    clear: ctx => commit(ctx, () => { state.clear(ctx); changed(ctx); }),
    setBudget: (ctx, budget) => commit(ctx, () => {
      state.require().tokenBudget = validateBudget(budget);
      state.enforceBudget();
      changed(ctx);
    }),
    pauseWithSession: ctx => coordination.run(ctx, () => {
      if (state.goal?.status === "active") state.setStatus(ctx, "paused");
    }),
    resumeWithSession: ctx => coordination.run(ctx, () => {
      if (!state.goal) return;

      if (state.goal.tokenBudget !== null && state.goal.tokensUsed >= state.goal.tokenBudget && state.goal.status !== "complete") throw new Error("Increase or clear the goal token budget before resuming.");

      if (["paused", "blocked", "usage_limited", "budget_limited"].includes(state.goal.status) && allowed()) { resetAudit(); state.setStatus(ctx, "active"); }
    }),
    usageGoalId: ctx => coordination.run(ctx, () => state.usageGoalId()),
    addSubagentUsage: (ctx, usage) => coordination.run(ctx, () => cumulativeUsage(ctx, usage)),
    replaySubagentUsage: ctx => coordination.run(ctx, () => {
      if (state.replaySubagentUsage(ctx) && state.goal) {
        steering(goalBudgetPrompt(state.goal));
        pause(ctx);
      }
    }),
  };

  const publish = pi.events.on("piop:goals:session", request => { request.session = session; });

  pi.on("context", (event, ctx) => coordination.run(ctx, () => {
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
    const messages = event.messages.filter(message => message.role !== "custom" || !["piop-goal-summary", GOAL_CONTEXT].includes(message.customType));

    if (state.goal) {
      const content = currentPrompt(state);
      messages.push({ role: "custom", customType: GOAL_CONTEXT, content, display: false, timestamp: Date.now() });
    } else if (event.messages.some(message => message.role === "custom" && message.customType === GOAL_CONTEXT)) {
      messages.push({ role: "custom", customType: GOAL_CONTEXT, content: goalChangedPrompt(null), display: false, timestamp: Date.now() });
    }

    return { messages };
  }));
  pi.on("session_shutdown", (_event, ctx) => coordination.run(ctx, () => {
    if (context) { state.finishRun(); state.save(context); }

    ready(); publish();
  }));

  return { session, core };
}

function currentPrompt(state: GoalState) {
  const goal = state.require();

  if (goal.status === "active") return goalPrompt(goal);

  if (goal.status === "budget_limited") return state.usageGoalId() === goal.id ? goalBudgetPrompt(goal) : goalInactivePrompt(goal);

  return goalChangedPrompt(goal);
}
