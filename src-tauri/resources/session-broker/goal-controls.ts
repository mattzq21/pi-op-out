import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { GoalState, validateBudget, validateObjective } from "./goal-state.ts";

export type GoalControls = {
  state: GoalState;
  assertAvailable(ctx: ExtensionContext): void;
  changed(ctx: ExtensionContext): void;
  start(ctx: ExtensionContext): void;
};
const USAGE = "/goal [objective|edit|pause|resume|clear|budget <tokens|clear>]";
type GoalToolInput = { action: "get" | "create" | "update"; objective?: string; tokenBudget?: number; status?: "complete" | "blocked" | "paused" };

function applyTool(input: GoalToolInput, ctx: ExtensionContext, state: GoalState) {
  if (input.action === "create") {
    if (input.objective === undefined || input.status !== undefined) throw new Error("Create requires objective and accepts only an optional tokenBudget.");
    state.create(ctx, input.objective, input.tokenBudget ?? null);
    return;
  }
  if (input.objective !== undefined || input.tokenBudget !== undefined) throw new Error("Only create accepts objective and tokenBudget. Use /goal commands to edit them.");
  if (input.action === "update") {
    if (!input.status) throw new Error("Update requires status: complete, blocked, or paused.");
    state.setStatus(ctx, input.status);
  } else if (input.status !== undefined) throw new Error("Get does not accept status.");
}

function registerGoalTool(pi: ExtensionAPI, controls: GoalControls) {
  pi.registerTool({
    name: "goal", label: "Conversation goal",
    description: "Manage a persistent conversation goal. Create only when the user explicitly asks for a goal or persistent work until an outcome is achieved; never infer a goal from an ordinary task. Supply a token budget only when explicitly requested. Get returns current status, token usage and elapsed active time. Update may mark complete only after verifying every requirement; blocked only after the same genuine blocker persists for at least three consecutive goal turns and no meaningful progress is possible; paused only on explicit user request. A resumed blocked goal starts a fresh audit. Never mark complete merely to stop or because a budget is exhausted. Resume, objective edits, budget changes and clearing belong to user /goal commands. On completion report the returned usage.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("create"), Type.Literal("update")]),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      tokenBudget: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      status: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")])),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      controls.assertAvailable(ctx);
      applyTool(params, ctx, controls.state);
      const data = controls.state.response();
      controls.state.save(ctx);
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  });
}

async function editGoal(ctx: ExtensionCommandContext, controls: GoalControls) {
  const goal = controls.state.require();
  const objective = await ctx.ui.editor("Edit goal", goal.objective);
  if (objective === undefined) return;
  if (controls.state.goal?.id !== goal.id) throw new Error("The goal changed while the editor was open. Reopen /goal edit.");
  const text = validateObjective(objective);
  controls.assertAvailable(ctx);
  controls.state.flushClock();
  goal.objective = text;
  if (["complete", "budget_limited"].includes(goal.status)) controls.state.setStatus(ctx, "active");
  controls.changed(ctx);
}

async function createGoal(args: string, ctx: ExtensionCommandContext, controls: GoalControls) {
  controls.assertAvailable(ctx);
  const objective = validateObjective(args);
  const previous = controls.state.goal;
  if (previous && previous.status !== "complete") {
    if (!await ctx.ui.confirm("Replace current goal?", "This starts a new objective with fresh usage and no token budget.")) return;
    if (controls.state.goal?.id !== previous.id) throw new Error("The goal changed. Submit /goal again.");
  }
  controls.state.clear(ctx);
  controls.state.create(ctx, objective, null);
  controls.changed(ctx);
}

function changeBudget(value: string, ctx: ExtensionCommandContext, controls: GoalControls) {
  const budget = value.trim() === "clear" ? null : Number(value.trim());
  controls.state.require().tokenBudget = validateBudget(budget);
  controls.state.enforceBudget();
  controls.changed(ctx);
}

async function command(args: string, ctx: ExtensionCommandContext, controls: GoalControls) {
  const value = args.trim();
  switch (value) {
    case "": return;
    case "edit": await editGoal(ctx, controls); return;
    case "clear": controls.state.clear(ctx); controls.changed(ctx); return;
    case "pause": controls.state.setStatus(ctx, "paused"); controls.changed(ctx); return;
    case "resume": controls.assertAvailable(ctx); controls.state.setStatus(ctx, "active"); controls.changed(ctx); return;
    default:
      if (value.startsWith("budget ")) changeBudget(value.slice(7), ctx, controls);
      else if (value === "budget") throw new Error(USAGE);
      else await createGoal(value, ctx, controls);
  }
}

export function registerGoalControls(pi: ExtensionAPI, controls: GoalControls) {
  registerGoalTool(pi, controls);
  pi.registerCommand("goal", {
    description: `Persistent conversation goal. ${USAGE}`,
    getArgumentCompletions: prefix => ["edit", "pause", "resume", "clear", "budget"].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      try {
        await command(args, ctx, controls);
        const summary = goalSummary(controls.state);
        controls.state.save(ctx);
        pi.sendMessage({ customType: "piop-goal-summary", content: summary, display: true }, { triggerTurn: false });
        if (args.trim()) controls.start(ctx);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}

function goalSummary(state: GoalState) {
  const { goal, remainingTokens } = state.response();
  if (!goal) return `No goal is set. ${USAGE}`;
  const budget = goal.tokenBudget === null ? `${goal.tokensUsed.toLocaleString()} used; no limit` : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} (${remainingTokens?.toLocaleString()} remaining)`;
  return `Goal ${goal.status.replaceAll("_", " ")}\n\n${goal.objective}\n\nTokens: ${budget}\nActive time: ${goal.timeUsedSeconds}s\n\n${USAGE}`;
}
