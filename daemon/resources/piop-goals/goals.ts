import { extendedHooks } from "../hooks-extended/interface.ts";
import { restoreGoalAttachments } from "../piop-storage/goal-files.ts";
import type { ExtensionAPI, ExtensionContext, AgentBeforeSettleEventResult, InputEventResult } from "@earendil-works/pi-coding-agent";
import { GoalState, GOAL_CONTEXT } from "./state.ts";
import { goalChangedPrompt, goalPrompt } from "./prompts.ts";
import { GoalCoordination } from "./coordination.ts";
import type { GoalSession } from "./interface.ts";
import type { GoalCore } from "./preparation.ts";
import { sessionControls } from "../piop-controls/interface.ts";
import { inputHold } from "../session-broker/input-hold.ts";

/** The user message that starts goal work when Pi is idle. */
const CONTINUE_TEXT = "Continue working toward the current conversation goal.";

/** A notice that the user changed the goal while the agent worked. The model gets it as a system message at its place in the history. */
const GOAL_CHANGE = "piop-goal-change";

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

/** Registers goal tracking for the session and publishes its GoalSession. Returns the goal internals for the goal tools and Piop input. */
export function registerGoals(pi: ExtensionAPI): { session: GoalSession; core: GoalCore } {
  const state = new GoalState(pi);

  const pause = (ctx: ExtensionContext) => {
    const controls = sessionControls(pi);

    if (!controls) { ctx.ui.notify("Session controls are unavailable, so the goal could not pause the run.", "error");

    return; }
    void controls.pause(ctx).catch(error => ctx.ui.notify((error instanceof Error ? error.message : String(error)), "error"));
  };

  const coordination = new GoalCoordination();

  const schedule = (ctx: ExtensionContext, operation: () => void) => {
    void coordination.run(ctx, operation).catch(error => ctx.ui.notify((error instanceof Error ? error.message : String(error)), "error"));
  };

  let context: ExtensionContext | undefined;
  let starting = false;
  let pendingStart = false;
  let restored = false;
  let runSignal: AbortSignal | undefined;

  const allowed = () => pi.getActiveTools().includes("update_goal_status");

  const assertAvailable = (ctx: ExtensionContext) => {
    if (!persistent(ctx)) throw new Error("Goals require a saved conversation.");

    if (!allowed()) throw new Error("Enable update_goal_status for this agent under Settings → Agents → Tools before starting a goal.");
  };

  const steering = (content: string) => pi.sendMessage({ customType: GOAL_CHANGE, content, display: false, details: { goalId: state.goal?.id } }, { triggerTurn: false });

  const start = (ctx: ExtensionContext) => {
    if (starting || state.goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    assertAvailable(ctx);
    starting = true;
    pendingStart = true;
    pi.sendUserMessage(CONTINUE_TEXT, { deliverAs: "followUp" });
  };

  /** Saves the goal. A running agent gets the notice, unless it is null. */
  const changed = (ctx: ExtensionContext, prompt: string | null = goalChangedPrompt(state.goal)) => {
    state.save(ctx);

    if (prompt !== null && !ctx.isIdle()) steering(prompt);
  };

  /** True from a resume during a task until that task ends. The continuation prompt waits until then. */
  let resumedInTask = false;

  /** The objective in the continuation prompt of the model's last request. */
  let seenObjective: string | undefined;

  const unseenEdit = () => state.goal && seenObjective !== undefined && seenObjective !== state.goal.objective ? goalChangedPrompt({ ...state.goal, status: "active" }) ?? undefined : undefined;

  const markSeen = () => { if (state.goal) seenObjective = state.goal.objective; };

  const core: GoalCore = { state, coordination, assertAvailable, changed, start, unseenEdit, markSeen };

  const restore = async (ctx: ExtensionContext) => {
    context = ctx; starting = false; pendingStart = false;

    try {
      state.restore(ctx);

      if (!persistent(ctx)) { state.goal = null; state.publish(ctx); }

      if (state.goal) await restoreGoalAttachments(ctx, state.goal.objective);

      restored = true;
    } catch (error) {
      state.goal = null; state.publish(ctx); restored = false;
      ctx.ui.notify(`Could not restore goal: ${(error instanceof Error ? error.message : String(error))}`, "error");
    }
  };

  extendedHooks(pi).on("session_restore", (_event, ctx) => coordination.run(ctx, () => restore(ctx)));

  const ready = pi.events.on("piop:agents:ready", ({ ctx }) => {
    schedule(ctx, () => {
    if (!restored || state.goal?.status !== "active") return;

    if (!allowed()) { state.setStatus(ctx, "paused");

    return; }

    // A chat waiting for the user's first message keeps its goal active; the user's message starts the work.
    if (inputHold(pi).held(ctx)) return;

    start(ctx);
    });
  });

  pi.on("input", (event, ctx) => coordination.run(ctx, (): InputEventResult | void => {
    starting = false;

    if (event.source === "extension" && pendingStart && event.text === CONTINUE_TEXT) {
      pendingStart = false;

      if (state.goal?.status !== "active") return { action: "handled" };
    }
  }));
  pi.on("agent_start", (_event, ctx) => coordination.run(ctx, () => {
    context = ctx; starting = false;
    runSignal = ctx.signal;
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
  }));

  pi.on("agent_before_settle", (event, ctx) => coordination.run(ctx, (): AgentBeforeSettleEventResult | void => {
    resumedInTask = false;
    if (event.outcome !== "completed") {
      if (state.goal?.status === "active") state.setStatus(ctx, "paused");
      if (event.outcome === "error") pause(ctx);
      return;
    }

    if (state.goal?.status !== "active") return;

    if (!allowed()) { state.setStatus(ctx, "paused");

    return; }

    // Waiting messages run first. Pi runs them only when asked to continue: a message that does not start a turn by itself,
    // such as the goal prompt sent after a compaction, would otherwise wait and the goal would stop.
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length) return { continue: true };

    return { continue: true, entries: [{ type: "custom_message", customType: GOAL_CONTEXT, content: goalPrompt(state.goal), display: false, details: { goalId: state.goal.id } }] };
  }));
  pi.on("agent_settled", (_event, ctx) => coordination.run(ctx, () => {
    starting = false; resumedInTask = false;

    if (state.goal?.status === "active" && runSignal?.aborted) state.setStatus(ctx, "paused");
    state.save(ctx);
  }));

  /** Runs a user operation, saves, reports the result, then starts work when the goal is active and Pi is idle. */
  const commit = (ctx: ExtensionContext, operation: () => void, startWork = true) => coordination.run(ctx, () => {
    operation();
    const report = state.response();
    state.save(ctx);

    if (startWork) start(ctx);

    return report;
  });

  const session: GoalSession = {
    pause: ctx => commit(ctx, () => { state.setStatus(ctx, "paused"); changed(ctx, null); }),
    resume: ctx => commit(ctx, () => { assertAvailable(ctx); state.setStatus(ctx, "active"); resumedInTask = !ctx.isIdle(); changed(ctx, null); }),
    clear: ctx => commit(ctx, () => { state.clear(ctx); changed(ctx); }),
    pauseWithSession: ctx => coordination.run(ctx, () => {
      if (state.goal?.status === "active") state.setStatus(ctx, "paused");
    }),
    resumeWithSession: ctx => coordination.run(ctx, () => {
      if (!state.goal) return;

      if (state.goal.status === "paused" && allowed()) state.setStatus(ctx, "active");
    }),
  };

  const publish = pi.events.on("piop:goals:session", request => { request.session = session; });

  pi.on("context", (event, ctx) => coordination.run(ctx, () => {
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
    // Earlier continuation prompts give way to the current one. Change notices stay where they happened, as system messages.
    const messages = event.messages.flatMap(message => message.role !== "custom" ? [message]
      : message.customType === GOAL_CONTEXT ? []
      : message.customType === GOAL_CHANGE ? [{ role: "system" as const, content: message.content, timestamp: message.timestamp }]
      : [message]);

    // The edit notice for the current objective gives the model that objective.
    const editNotice = state.goal && goalChangedPrompt({ ...state.goal, status: "active" });

    if (editNotice && messages.some(message => message.role === "system" && message.content === editNotice)) markSeen();

    // An active goal adds its continuation prompt as a user message. A paused or complete goal adds nothing.
    if (state.goal) {
      if (state.goal.status === "active" && !resumedInTask) {
        seenObjective = state.goal.objective;
        messages.push({ role: "custom", customType: GOAL_CONTEXT, content: goalPrompt(state.goal), display: false, timestamp: Date.now() });
      }
    } else if (event.messages.some(message => message.role === "custom" && message.customType === GOAL_CONTEXT)) {
      messages.push({ role: "system", content: goalChangedPrompt(null), timestamp: Date.now() });
    }

    return { messages };
  }));
  pi.on("session_shutdown", (_event, ctx) => coordination.run(ctx, () => {
    if (context) state.save(context);

    ready(); publish();
  }));

  return { session, core };
}
