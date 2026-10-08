import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { GoalState, GOAL_ENTRY, validateBudget, type Goal } from "./goal-state.ts";
import { goalImagesSchema, goalPreparationView, loadMaterializedGoal, materializeGoal, readGoalPreparation } from "./goal-files.ts";
import type { GoalCoordination } from "./goal-coordination.ts";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { randomUUID } from "node:crypto";

export type GoalControls = {
  state: GoalState;
  coordination: GoalCoordination;
  assertAvailable(ctx: ExtensionContext): void;
  changed(ctx: ExtensionContext): void;
  start(ctx: ExtensionContext): void;
};

const USAGE = "/goal [objective|edit|pause|resume|clear|budget <tokens|clear>]";

const promptSchema = Schema.Object({ message: Schema.String(), goalSubmissionId: Schema.Optional(Schema.String()), images: Schema.Optional(goalImagesSchema), prepared: Schema.Optional(Schema.Boolean()) });

const goalIdentitySchema = Schema.Object({ id: Schema.String() });

const preparationRequestSchema = Schema.Object({ goalSubmissionId: Schema.String() });

const isGoalObjective = (value: string) => Boolean(value) && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ");

function goalObjective(text: string) {
  const value = text.trimStart().match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();

  return value !== undefined && isGoalObjective(value) ? value : undefined;
}

function promptGoalObjective(message: string, images: Static<typeof goalImagesSchema>) {
  return goalObjective(message) ?? (images.length && message.trim() === "/goal" ? "" : undefined);
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

  const reused = await preparedGoalMatches(ctx, submissionId, captured.goal, captured.key);
  const objective = await goalInput(args, ctx, captured.goal, editing, reused);

  if (objective === undefined) return;

  return commitPreparedGoal(objective, ctx, controls, captured.key, editing, start, reused, submissionId, images);
}

async function preparedGoalMatches(ctx: ExtensionContext, submissionId: string | undefined, goal: Goal | null, captured: string) {
  if (!submissionId) return false;
  const previous = await readGoalPreparation(ctx, submissionId);

  if (!previous) return false;

  if (previous.goalId && previous.goalId === goal?.id) return true;

  if (previous.goalId && ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === GOAL_ENTRY && Check(goalIdentitySchema, entry.data) && entry.data.id === previous.goalId)) {
    throw new Error(`This submission already prepared a goal (${previous.objective}), but the current goal changed. Inspect the prepared goal in saved input recovery before retrying.`);
  }

  if (previous.expectedState !== undefined && previous.expectedState !== captured) throw new Error("The goal changed after this submission was prepared. Inspect saved input recovery before submitting a new goal.");

  return false;
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

    try {
      return await bindPreparedGoal(draft, ctx, controls, captured, editing, start, reused, Boolean(submissionId));
    } catch (error) { await draft.cleanup(); throw error; }
  });
}

function newPreparedGoal(ctx: ExtensionContext, objective: string, id: string = randomUUID()): Goal {
  const now = Date.now();

  return { version: 1, id, sessionId: ctx.sessionManager.getSessionId(), objective, status: "active", tokenBudget: null, tokensUsed: 0, elapsedMs: 0, createdAt: now, updatedAt: now };
}

async function bindPreparedGoal(draft: Awaited<ReturnType<typeof materializeGoal>>, ctx: ExtensionContext, controls: GoalControls, captured: string, editing: boolean, start: boolean, reused: boolean, stableIdentity: boolean) {
  if (snapshot(ctx, controls) !== captured) throw new Error("The conversation changed while preparing the goal. Submit /goal again.");
  controls.assertAvailable(ctx);
  const target = editing || reused ? controls.state.require() : newPreparedGoal(ctx, draft.objective, stableIdentity ? draft.goalId : undefined);
  await draft.bind(target.id, ctx, captured);
  let accepted = false;

  const accept = () => {
    if (accepted) return;
    controls.assertAvailable(ctx);

    if (!editing && controls.state.goal?.id === target.id && controls.state.goal.objective === draft.objective) { accepted = true;

    return; }

    if (snapshot(ctx, controls) !== captured) throw new Error("The goal changed before the prepared prompt was accepted. Restore the submission from saved input recovery.");

    if (!reused) applyDraft(ctx, controls, target, draft.objective, editing);
    accepted = true;
  };

  if (start) { accept(); controls.start(ctx); }

  return { summary: start ? goalSummary(controls.state) : undefined, objective: draft.objective, goalSubmissionId: draft.submissionId, accept };
}

async function resumePreparedGoal(message: string, ctx: ExtensionContext, controls: GoalControls, submissionId: string | undefined) {
  if (!submissionId) throw new Error("The queued goal has no preparation identity.");

  return controls.coordination.run(ctx, async () => {
    controls.assertAvailable(ctx);
    const captured = snapshot(ctx, controls);
    const reused = await preparedGoalMatches(ctx, submissionId, controls.state.goal, captured);
    const draft = await loadMaterializedGoal(ctx, submissionId);

    if (message !== goalPrompt(draft.objective)) throw new Error("The queued goal prompt does not match its saved preparation.");

    return bindPreparedGoal(draft, ctx, controls, captured, false, false, reused, true);
  });
}

function applyDraft(ctx: ExtensionContext, controls: GoalControls, target: Goal, objective: string, editing: boolean) {
  if (editing) {
    const goal = controls.state.require();
    controls.state.flushClock(); goal.objective = objective;

    if (["complete", "budget_limited"].includes(goal.status)) controls.state.setStatus(ctx, "active");
  } else {
    controls.state.finishRun(); controls.state.goal = target;

    if (!ctx.isIdle()) controls.state.beginRun();
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

  const preparePrompt = async (message: string, ctx: ExtensionContext, submissionId?: string, images: Static<typeof goalImagesSchema> = [], saved = false) => {
    const value = promptGoalObjective(message, images);

    if (value === undefined && !saved) return { message };

    try {
      const prepared = saved ? await resumePreparedGoal(message, ctx, controls, submissionId) : await prepareGoal(value ?? "", ctx, controls, false, false, submissionId, images);

      if (!prepared) throw new Error("Goal submission cancelled. The objective was not submitted.");

      return { message: goalPrompt(prepared.objective), goalSubmissionId: prepared.goalSubmissionId, accept: prepared.accept };
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); throw error; }
  };

  pi.events.on("piop:rpc", request => {
    if (request.command !== "prepare_goal_prompt") return;
    request.ready = (async () => {
      const prompt = Parse(promptSchema, request.payload);

      return preparePrompt(prompt.message, request.ctx, prompt.goalSubmissionId, prompt.images, prompt.prepared);
    })();
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "get_goal_preparation") return;
    request.ready = (async () => {
      const preparation = Parse(preparationRequestSchema, request.payload);

      return goalPreparationView(request.ctx, preparation.goalSubmissionId);
    })();
  });
  pi.on("input", (event, ctx) => {
    if (goalObjective(event.text) === undefined) return;

    ctx.ui.notify("Goal input was not prepared before dispatch. Restore the objective from saved input recovery and retry.", "error");

    return { action: "handled" };
  });
  pi.registerCommand("goal", {
    description: `Persistent conversation goal. ${USAGE}`,
    getArgumentCompletions: prefix => ["edit", "pause", "resume", "clear", "budget"].flatMap(value => value.startsWith(prefix.trim()) ? [{ value, label: value }] : []),
    async handler(args, ctx) {
      try {
        const value = args.trim();

        if (isGoalObjective(value)) {
          await prepareGoal(value, ctx, controls, false);

          return;
        }

        const summary = value === "edit" ? (await prepareGoal(value, ctx, controls, true))?.summary : await commit(ctx, controls, () => applyCommand(value, ctx, controls), Boolean(value));

        if (summary && value !== "clear") pi.sendMessage({ customType: "piop-goal-summary", content: summary, display: true }, { triggerTurn: false });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}

const goalPrompt = (objective: string) => `Work toward the conversation goal:\n\n${objective}`;

function goalSummary(state: GoalState) {
  const { goal, remainingTokens } = state.response();

  if (!goal) return `No goal is set. ${USAGE}`;
  const budget = goal.tokenBudget === null ? `${goal.tokensUsed.toLocaleString()} used; no limit` : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} (${remainingTokens?.toLocaleString()} remaining)`;

  return `Goal ${goal.status.replaceAll("_", " ")}\n\n${goal.objective}\n\nTokens: ${budget}\nActive time: ${goal.timeUsedSeconds}s\n\n${USAGE}`;
}
