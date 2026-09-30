import type { ExtensionAPI, ExtensionContext, AgentBeforeSettleEvent } from "@earendil-works/pi-coding-agent";
import { GoalState, GOAL_CONTEXT, goalTokens } from "./goal-state.ts";
import { goalBudgetPrompt, goalChangedPrompt, goalInactivePrompt, goalPrompt } from "./goal-prompts.ts";
import { registerGoalControls } from "./goal-controls.ts";

function persistent(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();
  return !!path && !/(?:^|[\\/])pi-desktop-btw-[^/\\]+\.jsonl$/.test(path);
}

export function registerGoals(pi: ExtensionAPI) {
  const state = new GoalState(pi);
  let context: ExtensionContext | undefined;
  let starting = false;
  let restored = false;
  let emptyTurns = 0;
  let failedTurns = 0;
  let activity = false;
  let successfulTool = false;
  let failedTool = false;
  let lastError = "";
  let automatic = false;
  let runGoalId: string | undefined;
  let responseGoalId: string | undefined;
  let runSignal: AbortSignal | undefined;
  const resetAudit = () => { emptyTurns = 0; failedTurns = 0; automatic = false; };
  const allowed = () => pi.getActiveTools().includes("goal");
  const assertAvailable = (ctx: ExtensionContext) => {
    if (!persistent(ctx)) throw new Error("Goals require a saved conversation and are unavailable in temporary side chats.");
    if (!allowed()) throw new Error("Enable the goal tool in Settings → Tools and allow it for this agent before starting a goal.");
  };
  const steering = (content: string) => pi.sendMessage({ customType: GOAL_CONTEXT, content, display: false, details: { goalId: state.goal?.id } }, { triggerTurn: false });
  const account = (ctx: ExtensionContext, tokens: number, includeStopped = false) => {
    if (state.account(ctx, tokens, includeStopped) && state.goal) steering(goalBudgetPrompt(state.goal));
  };
  const start = (ctx: ExtensionContext) => {
    if (starting || state.goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    assertAvailable(ctx);
    starting = true;
    pi.sendUserMessage("Continue working toward the active conversation goal.", { deliverAs: "followUp" });
  };
  const changed = (ctx: ExtensionContext) => {
    resetAudit(); state.save(ctx);
    if (!ctx.isIdle()) steering(goalChangedPrompt(state.goal));
  };
  registerGoalControls(pi, { state, assertAvailable, changed, start });

  const restore = (ctx: ExtensionContext, navigating: boolean) => {
    context = ctx; starting = false; resetAudit(); runGoalId = undefined;
    try {
      state.restore(ctx, navigating);
      if (!persistent(ctx)) { state.goal = null; state.publish(ctx); }
      restored = true;
    } catch (error) {
      state.goal = null; state.publish(ctx); restored = false;
      ctx.ui.notify(`Could not restore goal: ${String(error)}`, "error");
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx, false));
  pi.on("session_tree", (_event, ctx) => restore(ctx, true));
  const ready = pi.events.on("piop:agents:ready", value => {
    const { ctx } = value as { ctx: ExtensionContext };
    if (!restored || state.goal?.status !== "active") return;
    if (!allowed()) { state.setStatus(ctx, "paused"); return; }
    start(ctx);
  });
  pi.on("input", event => {
    starting = false;
    if (event.source !== "extension") resetAudit();
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx; starting = false;
    runSignal = ctx.signal;
    activity = false; successfulTool = false; failedTool = false; lastError = "";
    runGoalId = state.goal?.status === "active" ? state.goal.id : undefined;
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
    state.beginRun();
  });
  pi.on("message_start", event => {
    if (event.message.role !== "assistant") return;
    responseGoalId = state.usageGoalId();
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const message = event.message;
    activity ||= message.content.some(part => part.type === "toolCall" || (part.type === "text" ? part.text.trim() : part.thinking.trim()));
    lastError = message.errorMessage ?? "";
    if (responseGoalId && responseGoalId === state.goal?.id) account(ctx, goalTokens(message.usage), true);
    if (message.stopReason === "aborted" && state.goal?.status === "active") state.setStatus(ctx, "paused");
  });
  pi.on("tool_result", (event, ctx) => {
    activity = true;
    successfulTool ||= !event.isError;
    failedTool ||= event.isError;
    account(ctx, 0);
  });
  pi.on("session_compact", (event, ctx) => {
    account(ctx, goalTokens(event.compactionEntry.usage));
    if (state.goal?.status === "active") steering(goalPrompt(state.goal));
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (event.errorMessage && state.goal?.status === "active") state.setStatus(ctx, "blocked");
  });
  pi.on("agent_end", (_event, ctx) => { state.flushClock(true); state.save(ctx); });

  const stopForOutcome = (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
    if (event.outcome === "completed") return false;
    if (!state.usageGoalId()) return false;
    if (event.outcome === "aborted") state.setStatus(ctx, "paused");
    else state.setStatus(ctx, /quota|usage.limit|rate.limit|too many requests|429/i.test(lastError) ? "usage_limited" : "blocked");
    return true;
  };
  const stalled = () => {
    emptyTurns = automatic && !activity ? emptyTurns + 1 : 0;
    if (successfulTool) failedTurns = 0;
    else if (failedTool) failedTurns++;
    return emptyTurns >= 3 || failedTurns >= 3;
  };
  pi.on("agent_before_settle", (event, ctx) => {
    if (stopForOutcome(event, ctx)) return;
    if (state.goal?.status !== "active") return;
    if (!allowed()) { state.setStatus(ctx, "paused"); return; }
    if (runGoalId !== state.goal.id) resetAudit();
    if (stalled()) { state.setStatus(ctx, "blocked"); return; }
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
    automatic = true;
    return { continue: true, entries: [{ type: "custom_message" as const, customType: GOAL_CONTEXT, content: goalPrompt(state.goal), display: false, details: { goalId: state.goal.id } }] };
  });
  pi.on("agent_settled", (_event, ctx) => {
    starting = false; state.finishRun(); responseGoalId = undefined;
    if (state.goal?.status === "active" && runSignal?.aborted) state.setStatus(ctx, "paused");
    state.save(ctx);
  });

  const stopControl = pi.events.on("piop:goal-control", value => {
    const { action, ctx } = value as { action: "pause" | "resume"; ctx: ExtensionContext };
    if (!state.goal) return;
    if (action === "pause" && state.goal.status === "active") state.setStatus(ctx, "paused");
    if (action === "resume" && state.goal.status === "paused" && allowed()) { resetAudit(); state.setStatus(ctx, "active"); }
  });
  const scope = pi.events.on("piop:goal-scope", value => {
    (value as { goalId?: string }).goalId = state.usageGoalId();
  });
  const usage = pi.events.on("piop:goal-usage", value => {
    const event = value as { goalId?: string; tokens: number; ctx: ExtensionContext };
    if (event.goalId && event.goalId === state.goal?.id) account(event.ctx, event.tokens, true);
  });
  pi.on("context", (event, ctx) => {
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
    const messages = event.messages.filter(message => message.role !== "custom" || !["piop-goal-summary", GOAL_CONTEXT].includes(message.customType));
    if (state.goal) {
      const content = currentPrompt(state);
      messages.push({ role: "custom", customType: GOAL_CONTEXT, content, display: false, timestamp: Date.now() });
    } else if (event.messages.some(message => message.role === "custom" && message.customType === GOAL_CONTEXT)) {
      messages.push({ role: "custom", customType: GOAL_CONTEXT, content: goalChangedPrompt(null), display: false, timestamp: Date.now() });
    }
    return { messages };
  });
  pi.on("session_shutdown", () => {
    if (context) { state.finishRun(); state.save(context); }
    ready(); stopControl(); scope(); usage();
  });
}

function currentPrompt(state: GoalState) {
  const goal = state.require();
  if (goal.status === "active") return goalPrompt(goal);
  if (goal.status === "budget_limited") return state.usageGoalId() === goal.id ? goalBudgetPrompt(goal) : goalInactivePrompt(goal);
  return goalChangedPrompt(goal);
}
