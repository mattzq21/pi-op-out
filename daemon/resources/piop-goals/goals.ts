import { extendedHooks } from "../hooks-extended/interface.ts";
import { restoreGoalAttachments } from "../piop-storage/goal-files.ts";
import type { ExtensionAPI, ExtensionContext, AgentBeforeSettleEventResult } from "@earendil-works/pi-coding-agent";
import { GoalState, GOAL_CONTEXT, type Goal } from "./state.ts";
import { goalChangedPrompt, goalPrompt } from "./prompts.ts";
import { GoalCoordination } from "./coordination.ts";
import type { GoalSession } from "./interface.ts";
import type { GoalCore } from "./preparation.ts";
import { sessionControls } from "../piop-controls/interface.ts";
import { inputHold } from "../session-broker/input-hold.ts";

/** A notice that the user changed the goal. It is saved where the change happened, and the model gets it there as a system message. */
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
  let restored = false;
  let runSignal: AbortSignal | undefined;

  const allowed = () => pi.getActiveTools().includes("update_goal_status");

  const assertAvailable = (ctx: ExtensionContext) => {
    if (!persistent(ctx)) throw new Error("Goals require a saved conversation.");

    if (!allowed()) throw new Error("Enable update_goal_status for this agent under Settings → Agents → Tools before starting a goal.");
  };

  /** Saves a change notice in the history. While the agent works, Pi adds it at the end of the current turn. */
  const notice = (content: string) => pi.sendMessage({ customType: GOAL_CHANGE, content, display: false, details: { goalId: state.goal?.id } }, { triggerTurn: false });

  /** The objective of the last goal prompt that the model got. */
  let seenObjective: string | undefined;

  /** The goal prompt: a saved user message that the chat shows as a goal message. It is added once, each time the goal queues more work. */
  const promptMessage = (goal: Goal) => {
    seenObjective = goal.objective;

    return { customType: GOAL_CONTEXT, content: goalPrompt(goal), display: true, details: { goalId: goal.id } };
  };

  const start = (ctx: ExtensionContext) => {
    if (starting || state.goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    assertAvailable(ctx);
    starting = true;
    pi.sendMessage(promptMessage(state.goal), { triggerTurn: true, deliverAs: "followUp" });
  };

  /** Saves the goal and the change notice, unless the notice is null. */
  const changed = (ctx: ExtensionContext, prompt: string | null = goalChangedPrompt(state.goal)) => {
    state.save(ctx);

    if (prompt !== null) notice(prompt);
  };

  const unseenEdit = () => state.goal && seenObjective !== undefined && seenObjective !== state.goal.objective ? goalChangedPrompt({ ...state.goal, status: "active" }) ?? undefined : undefined;

  const markSeen = () => { if (state.goal) seenObjective = state.goal.objective; };

  const core: GoalCore = { state, coordination, assertAvailable, changed, start, unseenEdit, markSeen };

  const restore = async (ctx: ExtensionContext) => {
    context = ctx; starting = false;

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

  pi.on("agent_start", (_event, ctx) => coordination.run(ctx, () => {
    context = ctx; starting = false;
    runSignal = ctx.signal;
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
  }));

  pi.on("agent_before_settle", (event, ctx) => coordination.run(ctx, (): AgentBeforeSettleEventResult | void => {
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
    ctx.ui.notify('[DEBUG-gq7] settle pending=' + ctx.hasPendingMessages() + ' context=' + event.context.pendingMessages.length, 'info');
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length) return { continue: true };

    return { continue: true, entries: [{ type: "custom_message", ...promptMessage(state.goal) }] };
  }));
  pi.on("agent_settled", (_event, ctx) => coordination.run(ctx, () => {
    starting = false;

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
    resume: ctx => commit(ctx, () => { assertAvailable(ctx); state.setStatus(ctx, "active"); changed(ctx, null); }),
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
    // Change notices stay where they happened, as system messages. Goal prompts stay as the user messages they were saved as.
    const messages = event.messages.map(message => message.role === "custom" && message.customType === GOAL_CHANGE ? { role: "system" as const, content: message.content, timestamp: message.timestamp } : message);

    // The edit notice for the current objective gives the model that objective.
    const editNotice = state.goal && goalChangedPrompt({ ...state.goal, status: "active" });

    if (editNotice && messages.some(message => message.role === "system" && message.content === editNotice)) markSeen();

    return { messages };
  }));
  pi.on("session_shutdown", (_event, ctx) => coordination.run(ctx, () => {
    if (context) state.save(context);

    ready(); publish();
  }));

  return { session, core };
}
