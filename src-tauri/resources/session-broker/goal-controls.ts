import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { GoalState, validateBudget, type Goal } from "./goal-state.ts";
import { goalImagesSchema, goalPreparationView, materializeGoal, readGoalPreparation } from "./goal-files.ts";
import type { GoalCoordination } from "./goal-coordination.ts";
import { Type as Schema, type Static } from "typebox";
import { Parse } from "typebox/value";

export type GoalControls = {
  state: GoalState;
  coordination: GoalCoordination;
  assertAvailable(ctx: ExtensionContext): void;
  changed(ctx: ExtensionContext): void;
  start(ctx: ExtensionContext): void;
};

const USAGE = "/goal [objective|edit|pause|resume|clear|budget <tokens|clear>]";

const promptSchema = Schema.Object({ message: Schema.String(), goalSubmissionId: Schema.Optional(Schema.String()), images: Schema.Optional(goalImagesSchema) });

const preparationRequestSchema = Schema.Object({ goalSubmissionId: Schema.String() });

const isGoalObjective = (value: string) => Boolean(value) && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ");

function goalObjective(text: string) {
  const value = text.trimStart().match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();

  return value !== undefined && isGoalObjective(value) ? value : undefined;
}

const goalToolDescription = "Update the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.";

function registerGoalTool(pi: ExtensionAPI, controls: GoalControls) {
  const result = (ctx: ExtensionContext, completed = false): AgentToolResult<ReturnType<GoalState["response"]>> => {
    const data = controls.state.response(completed);

    if (completed && data.goal?.status === "complete") controls.state.clear(ctx);
    else controls.state.save(ctx);

    return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  };

  pi.registerTool({
    name: "get_goal", label: "Get goal", description: "Get the current goal, including status, budget, token and elapsed-time usage, and remaining token budget.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      return controls.coordination.run(ctx, () => { signal?.throwIfAborted(); controls.assertAvailable(ctx);

      return result(ctx); });
    },
  });
  pi.registerTool({
    name: "create_goal", label: "Create goal", description: "Create a goal only when explicitly requested by the user or system/developer instructions; never infer goals from ordinary tasks. Set token_budget only when explicitly requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object({ objective: Type.String(), token_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return controls.coordination.run(ctx, () => {
      signal?.throwIfAborted(); controls.assertAvailable(ctx);
      controls.state.create(ctx, params.objective, params.token_budget ?? null);

      return result(ctx);
      });
    },
  });
  pi.registerTool({
    name: "update_goal", label: "Update goal", description: goalToolDescription,
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")]) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return controls.coordination.run(ctx, () => {
      signal?.throwIfAborted(); controls.assertAvailable(ctx);
      controls.state.setStatus(ctx, params.status); controls.state.finishRun();

      return result(ctx, params.status === "complete");
      });
    },
  });
}

function snapshot(ctx: ExtensionContext, controls: GoalControls) {
  const goal = controls.state.goal;

  return JSON.stringify([ctx.sessionManager.getSessionId(), goal?.id, goal?.objective, goal?.status, goal?.tokenBudget]);
}

function commit(ctx: ExtensionContext, controls: GoalControls, operation: () => void, start = true) {
  return controls.coordination.run(ctx, () => {
    operation();
    const summary = goalSummary(controls.state);
    controls.state.save(ctx);

    if (start) controls.start(ctx);

    return summary;
  });
}

async function prepareGoal(args: string, ctx: ExtensionContext, controls: GoalControls, editing: boolean, start = true, submissionId?: string, images: Static<typeof goalImagesSchema> = []) {
  const captured = await controls.coordination.run(ctx, () => {
    controls.assertAvailable(ctx);

    if (editing) controls.state.require();

    return { key: snapshot(ctx, controls), goal: controls.state.goal && { ...controls.state.goal } };
  });

  const reused = await preparedGoalMatches(ctx, submissionId, captured.goal);
  const objective = await goalInput(args, ctx, captured.goal, editing, reused);

  if (objective === undefined) return;

  return commitPreparedGoal(objective, ctx, controls, captured.key, editing, start, reused, submissionId, images);
}

async function preparedGoalMatches(ctx: ExtensionContext, submissionId: string | undefined, goal: Goal | null) {
  if (!submissionId) return false;
  const previous = await readGoalPreparation(ctx, submissionId);

  if (!previous || !goal) return false;

  if (!previous.goalId) return previous.objective === goal.objective;

  if (previous.goalId === goal.id) return true;

  throw new Error(`This submission already prepared a goal (${previous.objective}), but the current goal changed. Inspect the prepared goal in saved input recovery before retrying.`);
}

async function goalInput(args: string, ctx: ExtensionContext, goal: Goal | null, editing: boolean, reused: boolean) {
  if (editing) {
    if (!goal) throw new Error("No goal is set for this conversation.");

    return ctx.ui.editor("Edit goal", goal.objective);
  }

  if (!reused && goal && goal.status !== "complete" && !await ctx.ui.confirm("Replace current goal?", "This starts a new objective with fresh usage and no token budget.")) return;

  return args;
}

function commitPreparedGoal(objective: string, ctx: ExtensionContext, controls: GoalControls, captured: string, editing: boolean, start: boolean, reused: boolean, submissionId: string | undefined, images: Static<typeof goalImagesSchema>) {
  return controls.coordination.run(ctx, async () => {
    if (snapshot(ctx, controls) !== captured) throw new Error("The goal changed while preparing this operation. Submit /goal again.");
    controls.assertAvailable(ctx);
    const draft = await materializeGoal(objective, ctx, submissionId, images);
    let applied = false;

    try {
      if (snapshot(ctx, controls) !== captured) throw new Error("The conversation changed while preparing the goal. Submit /goal again.");
      controls.assertAvailable(ctx);

      if (!reused) applyDraft(ctx, controls, draft.objective, editing);
      applied = true;
      await draft.bind(controls.state.require().id, ctx);
      controls.state.save(ctx);

      if (start) controls.start(ctx);

      return { summary: goalSummary(controls.state), objective: draft.objective };
    } finally { if (!applied) await draft.cleanup(); }
  });
}

function applyDraft(ctx: ExtensionContext, controls: GoalControls, objective: string, editing: boolean) {
  if (editing) {
    const goal = controls.state.require();
    controls.state.flushClock(); goal.objective = objective;

    if (["complete", "budget_limited"].includes(goal.status)) controls.state.setStatus(ctx, "active");
  } else {
    controls.state.clear(ctx); controls.state.create(ctx, objective, null);
  }

  controls.changed(ctx);
}

function changeBudget(value: string, ctx: ExtensionCommandContext, controls: GoalControls) {
  const budget = value.trim() === "clear" ? null : Number(value.trim());
  controls.state.require().tokenBudget = validateBudget(budget);
  controls.state.enforceBudget();
  controls.changed(ctx);
}

function applyCommand(value: string, ctx: ExtensionCommandContext, controls: GoalControls) {
  switch (value) {
    case "": return;
    case "clear": controls.state.clear(ctx); controls.changed(ctx);

    return;
    case "pause": controls.state.setStatus(ctx, "paused"); controls.changed(ctx);

    return;
    case "resume": controls.assertAvailable(ctx); controls.state.setStatus(ctx, "active"); controls.changed(ctx);

    return;
    default:
      if (value.startsWith("budget ")) changeBudget(value.slice(7), ctx, controls);
      else throw new Error(USAGE);
  }
}

export function registerGoalControls(pi: ExtensionAPI, controls: GoalControls) {
  registerGoalTool(pi, controls);

  const preparePrompt = async (message: string, ctx: ExtensionContext, submissionId?: string, images: Static<typeof goalImagesSchema> = []) => {
    const value = goalObjective(message) ?? (images.length && message.trim() === "/goal" ? "" : undefined);

    if (value === undefined) return message;

    try {
      const prepared = await prepareGoal(value, ctx, controls, false, false, submissionId, images);

      if (!prepared) throw new Error("Goal submission cancelled. The objective was not submitted.");

      return `Work toward the conversation goal:\n\n${prepared.objective}`;
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); throw error; }
  };

  pi.events.on("piop:rpc", request => {
    if (request.command !== "prepare_goal_prompt") return;
    request.ready = (async () => {
      const prompt = Parse(promptSchema, request.payload);

      return { message: await preparePrompt(prompt.message, request.ctx, prompt.goalSubmissionId, prompt.images) };
    })();
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "get_goal_preparation") return;
    request.ready = (async () => {
      const preparation = Parse(preparationRequestSchema, request.payload);

      return goalPreparationView(request.ctx, preparation.goalSubmissionId);
    })();
  });
  pi.on("input", async (event, ctx) => {
    if (goalObjective(event.text) === undefined) return;

    try { return { action: "transform", text: await preparePrompt(event.text, ctx, undefined, event.images), images: [] }; }
    catch { return { action: "handled" }; }
  });
  pi.registerCommand("goal", {
    description: `Persistent conversation goal. ${USAGE}`,
    getArgumentCompletions: prefix => ["edit", "pause", "resume", "clear", "budget"].flatMap(value => value.startsWith(prefix.trim()) ? [{ value, label: value }] : []),
    async handler(args, ctx) {
      try {
        const value = args.trim();

        if (isGoalObjective(value)) {
          pi.sendUserMessage(await preparePrompt(`/goal ${value}`, ctx), { deliverAs: "followUp" });

          return;
        }

        const summary = value === "edit" ? (await prepareGoal(value, ctx, controls, true))?.summary : await commit(ctx, controls, () => applyCommand(value, ctx, controls), Boolean(value));

        if (summary && value !== "clear") pi.sendMessage({ customType: "piop-goal-summary", content: summary, display: true }, { triggerTurn: false });
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
