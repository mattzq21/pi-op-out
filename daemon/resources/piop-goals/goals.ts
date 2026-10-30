import { extendedHooks } from "../hooks-extended/interface.ts";
import { restoreGoalAttachments } from "../piop-storage/goal-files.ts";
import type { ExtensionAPI, ExtensionContext, AgentBeforeSettleEventResult } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { GoalState, GOAL_CONTEXT, type Goal } from "./state.ts";
import { goalChangedPrompt, goalPrompt } from "./prompts.ts";
import { GoalCoordination } from "./coordination.ts";
import type { GoalSession } from "./interface.ts";
import type { GoalCore } from "./preparation.ts";
import { inputHold } from "../session-broker/input-hold.ts";
import { queueHold } from "../session-broker/queue-hold.ts";

/** A notice that the user changed the goal. It is saved where the change happened, and the model gets it there as a system message. */
const GOAL_CHANGE = "piop-goal-change";

const GOAL_TOOL = "update_goal_status";

interface AgentsReady { ctx: ExtensionContext }

interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; withheldTools: string[]; availableTools?: string[] }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:ready", handler: (event: AgentsReady) => void): () => void;
    emit(channel: "piop:agents:ready", event: AgentsReady): void;
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

/** From the transcript: whether the prompt declares the goal tool, and whether a compaction came after the last model reply. */
function transcriptTool(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  const messages = branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
  const compaction = branch.findLastIndex(entry => entry.type === "compaction");
  const reply = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant");

  return { declared: getCurrentTools(messages).some(tool => tool.name === GOAL_TOOL), compacted: compaction > reply };
}

function persistent(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  return !!path;
}

/** Registers goal tracking for the session and publishes its GoalSession. Returns the goal internals for the goal tools and Piop input. */
export function registerGoals(pi: ExtensionAPI): { session: GoalSession; core: GoalCore } {
  const state = new GoalState(pi, ctx => inputHold(pi).held(ctx));

  const coordination = new GoalCoordination();

  const schedule = (ctx: ExtensionContext, operation: () => void) => {
    void coordination.run(ctx, operation).catch(error => ctx.ui.notify((error instanceof Error ? error.message : String(error)), "error"));
  };

  let context: ExtensionContext | undefined;
  let starting = false;
  let restored = false;
  let runSignal: AbortSignal | undefined;

  /** The agent's tools include the goal tool. */
  let permitted = false;
  /** The goal tool is in the prompt: from goal creation until the first message after a compaction without a goal. */
  let declared = false;
  /** A compaction happened and the next message has not started yet. */
  let recheck = false;
  let running = false;

  /** A goal that is active or paused. */
  const live = () => !!state.goal && state.goal.status !== "complete";

  /** Puts the goal tool in the active tools, or takes it out, as declared says. */
  const syncTool = () => {
    const active = pi.getActiveTools();
    const shown = declared && permitted;

    if (shown !== active.includes(GOAL_TOOL)) pi.setActiveTools(shown ? [...active, GOAL_TOOL] : active.filter(name => name !== GOAL_TOOL));
  };

  const declare = () => { if (live() && !declared) { declared = true; syncTool(); } };

  /** The first message after a compaction drops the goal tool when there is no goal. */
  const recheckTool = () => {
    if (!recheck) return;
    recheck = false;

    if (live()) return;
    declared = false; syncTool();
  };

  const allowed = () => permitted && (!declared || pi.getActiveTools().includes(GOAL_TOOL));

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

  /** Goal work goes through the queue: it starts only when the goal is active and first, so no message waits ahead of it and the queue is not on hold. */
  const start = (ctx: ExtensionContext) => {
    if (starting || state.goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages() || queueHold(pi).held()) return;
    assertAvailable(ctx);
    starting = true;
    pi.sendMessage(promptMessage(state.goal), { triggerTurn: true, deliverAs: "followUp" });
  };

  /** Saves the goal and the change notice, unless the notice is null. */
  const changed = (ctx: ExtensionContext, prompt: string | null = goalChangedPrompt(state.goal)) => {
    state.save(ctx);
    declare();

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

      const transcript = transcriptTool(ctx);
      declared = live() || transcript.declared; recheck = transcript.compacted; syncTool();

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

  const requiredTools = pi.events.on("piop:required-tools", request => {
    permitted = request.availableTools?.includes(GOAL_TOOL) ?? false;

    if (!declared) request.withheldTools.push(GOAL_TOOL);
  });

  // A compaction during a run comes right before the next model request; between runs, the next run's start decides.
  pi.on("session_compact", () => { recheck = true; if (running) recheckTool(); });
  pi.on("before_agent_start", () => { recheckTool(); });

  pi.on("agent_start", () => { running = true; });
  pi.on("agent_settled", () => { running = false; });

  pi.on("agent_start", (_event, ctx) => coordination.run(ctx, () => {
    context = ctx; starting = false;
    runSignal = ctx.signal;
    if (state.goal?.status === "active" && !allowed()) state.setStatus(ctx, "paused");
  }));

  pi.on("agent_before_settle", (event, ctx) => coordination.run(ctx, (): AgentBeforeSettleEventResult | void => {
    if (event.outcome !== "completed") {
      if (state.goal?.status === "active") state.setStatus(ctx, "paused");
      return;
    }

    if (state.goal?.status !== "active") return;

    if (!allowed()) { state.setStatus(ctx, "paused");

    return; }

    // Waiting messages run first. Pi runs them only when asked to continue: a message that does not start a turn by itself,
    // such as the goal prompt sent after a compaction, would otherwise wait and the goal would stop.
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length) return { continue: true };

    // A held queue holds the goal too. The goal stays active, and its work starts again when the user resumes the queue.
    if (queueHold(pi).held()) return;

    return { continue: true, entries: [{ type: "custom_message", ...promptMessage(state.goal) }] };
  }));
  let released: (() => void) | undefined;
  let inputReleased: (() => void) | undefined;
  pi.on("session_start", () => {
    released ??= queueHold(pi).onRelease(ctx => schedule(ctx, () => start(ctx)));
    inputReleased ??= inputHold(pi).onRelease(ctx => schedule(ctx, () => state.publish(ctx)));
  });
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
    stopped: ctx => coordination.run(ctx, () => {
      if (state.goal?.status === "active") state.setStatus(ctx, "paused");
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

    ready(); publish(); requiredTools(); released?.(); released = undefined; inputReleased?.(); inputReleased = undefined;
  }));

  return { session, core };
}
