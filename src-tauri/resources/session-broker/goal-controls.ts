import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { GoalState, validateBudget } from "./goal-state.ts";
import { materializeGoal } from "./goal-files.ts";

export type GoalControls = {
  state: GoalState;
  assertAvailable(ctx: ExtensionContext): void;
  changed(ctx: ExtensionContext): void;
  start(ctx: ExtensionContext): void;
};
const USAGE = "/goal [objective|edit|pause|resume|clear|budget <tokens|clear>]";
const goalToolDescription = "Update the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.";

function registerGoalTool(pi: ExtensionAPI, controls: GoalControls) {
  const result = (ctx: ExtensionContext, completed = false) => {
    const data = controls.state.response(completed);
    controls.state.save(ctx);
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
  };
  pi.registerTool({
    name: "get_goal", label: "Get goal", description: "Get the current goal, including status, budget, token and elapsed-time usage, and remaining token budget.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted(); controls.assertAvailable(ctx); return result(ctx);
    },
  });
  pi.registerTool({
    name: "create_goal", label: "Create goal", description: "Create a goal only when explicitly requested by the user or system/developer instructions; never infer goals from ordinary tasks. Set token_budget only when explicitly requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object({ objective: Type.String(), token_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); controls.assertAvailable(ctx);
      controls.state.create(ctx, params.objective, params.token_budget ?? null);
      return result(ctx);
    },
  });
  pi.registerTool({
    name: "update_goal", label: "Update goal", description: goalToolDescription,
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")]) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); controls.assertAvailable(ctx);
      controls.state.setStatus(ctx, params.status); controls.state.finishRun();
      return result(ctx, params.status === "complete");
    },
  });
}

async function editGoal(ctx: ExtensionCommandContext, controls: GoalControls) {
  const goal = controls.state.require();
  const objective = await ctx.ui.editor("Edit goal", goal.objective);
  if (objective === undefined) return;
  if (controls.state.goal?.id !== goal.id) throw new Error("The goal changed while the editor was open. Reopen /goal edit.");
  controls.assertAvailable(ctx);
  const draft = await materializeGoal(objective, ctx);
  if (controls.state.goal?.id !== goal.id) { await draft.cleanup(); throw new Error("The goal changed. Reopen /goal edit."); }
  controls.state.flushClock();
  goal.objective = draft.objective;
  if (["complete", "budget_limited"].includes(goal.status)) controls.state.setStatus(ctx, "active");
  controls.changed(ctx);
}

async function createGoal(args: string, ctx: ExtensionCommandContext, controls: GoalControls) {
  controls.assertAvailable(ctx);
  const previous = controls.state.goal;
  if (previous && previous.status !== "complete") {
    if (!await ctx.ui.confirm("Replace current goal?", "This starts a new objective with fresh usage and no token budget.")) return;
    if (controls.state.goal?.id !== previous.id) throw new Error("The goal changed. Submit /goal again.");
  }
  const draft = await materializeGoal(args, ctx);
  if (controls.state.goal !== previous) { await draft.cleanup(); throw new Error("The goal changed. Submit /goal again."); }
  controls.state.clear(ctx);
  controls.state.create(ctx, draft.objective, null);
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
