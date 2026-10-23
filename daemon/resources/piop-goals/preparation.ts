import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalState, Goal } from "./state.ts";
import { goalImagesSchema, loadMaterializedGoal, materializeGoal, readGoalPreparation } from "../piop-storage/goal-files.ts";
import type { GoalCoordination } from "./coordination.ts";
import { goalSetPrompt } from "./prompts.ts";
import type { Static } from "typebox";
import { randomUUID } from "node:crypto";

/** Goal internals shared by the goal tools and goal input preparation. */
export type GoalCore = {
  state: GoalState;
  coordination: GoalCoordination;
  /** Throws when the conversation is not saved or the goal tools are disabled. */
  assertAvailable(ctx: ExtensionContext): void;
  /** Saves and tells a running agent about the change. */
  changed(ctx: ExtensionContext, prompt?: string | null): void;
  /** Starts goal work when the goal is active and Pi is idle. */
  start(ctx: ExtensionContext): void;
  /** The edit notice when the user changed the objective after the model's last request, so the model has not seen the current objective. Else undefined. */
  unseenEdit(): string | undefined;
  /** Records that the model got the current objective, for example in a tool error. */
  markSeen(): void;
};

/** The user message that starts work toward a prepared objective: the /goal command as the user wrote it. */
export const objectivePrompt = (objective: string) => `/goal ${objective}`;

function snapshot(ctx: ExtensionContext, core: GoalCore) {
  const goal = core.state.goal;

  return JSON.stringify([ctx.sessionManager.getSessionId(), goal?.id, goal?.objective, goal?.status]);
}

export async function prepareGoal(args: string, ctx: ExtensionContext, core: GoalCore, editing: boolean, start = true, submissionId?: string, images: Static<typeof goalImagesSchema> = []) {
  const captured = await core.coordination.run(ctx, () => {
    core.assertAvailable(ctx);

    if (editing) core.state.require();

    return { key: snapshot(ctx, core), goal: core.state.goal && { ...core.state.goal } };
  });

  const reused = await preparedGoalMatches(ctx, core, submissionId, captured.goal, captured.key);
  const objective = await goalInput(args, ctx, captured.goal, editing, reused);

  if (objective === undefined) return;

  return commitPreparedGoal(objective, ctx, core, captured.key, editing, start, reused, submissionId, images);
}

async function preparedGoalMatches(ctx: ExtensionContext, core: GoalCore, submissionId: string | undefined, goal: Goal | null, captured: string) {
  if (!submissionId) return false;
  const previous = await readGoalPreparation(ctx, submissionId);

  if (!previous) return false;

  if (previous.goalId && previous.goalId === goal?.id) return true;

  if (previous.goalId && core.state.known(ctx, previous.goalId)) {
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

  if (!reused && goal && goal.status !== "complete" && !await ctx.ui.confirm("Replace current goal?", "This replaces the current objective.")) return;

  return args;
}

function commitPreparedGoal(objective: string, ctx: ExtensionContext, core: GoalCore, captured: string, editing: boolean, start: boolean, reused: boolean, submissionId: string | undefined, images: Static<typeof goalImagesSchema>) {
  return core.coordination.run(ctx, async () => {
    if (snapshot(ctx, core) !== captured) throw new Error("The goal changed while preparing this operation. Submit /goal again.");
    core.assertAvailable(ctx);
    const draft = await materializeGoal(objective, ctx, submissionId, images);

    try {
      return await bindPreparedGoal(draft, ctx, core, captured, editing, start, reused, Boolean(submissionId));
    } catch (error) { await draft.cleanup(); throw error; }
  });
}

function newPreparedGoal(ctx: ExtensionContext, objective: string, id: string = randomUUID()): Goal {
  return { id, sessionId: ctx.sessionManager.getSessionId(), objective, status: "active" };
}

async function bindPreparedGoal(draft: Awaited<ReturnType<typeof materializeGoal>>, ctx: ExtensionContext, core: GoalCore, captured: string, editing: boolean, start: boolean, reused: boolean, stableIdentity: boolean) {
  if (snapshot(ctx, core) !== captured) throw new Error("The conversation changed while preparing the goal. Submit /goal again.");
  core.assertAvailable(ctx);
  const target = editing || reused ? core.state.require() : newPreparedGoal(ctx, draft.objective, stableIdentity ? draft.goalId : undefined);
  await draft.bind(target.id, ctx, captured);
  let accepted = false;

  const accept = () => {
    if (accepted) return;
    core.assertAvailable(ctx);

    if (!editing && core.state.goal?.id === target.id && core.state.goal.objective === draft.objective) { accepted = true;

    return; }

    if (snapshot(ctx, core) !== captured) throw new Error("The goal changed before the prepared prompt was accepted. Restore the submission from saved input recovery.");

    if (!reused) applyDraft(ctx, core, target, draft.objective, editing);
    accepted = true;
  };

  if (start) { accept(); core.start(ctx); }

  return { report: start ? core.state.response() : undefined, objective: draft.objective, goalSubmissionId: draft.submissionId, accept };
}

export async function resumePreparedGoal(message: string, ctx: ExtensionContext, core: GoalCore, submissionId: string | undefined) {
  if (!submissionId) throw new Error("The queued goal has no preparation identity.");

  return core.coordination.run(ctx, async () => {
    core.assertAvailable(ctx);
    const captured = snapshot(ctx, core);
    const reused = await preparedGoalMatches(ctx, core, submissionId, core.state.goal, captured);
    const draft = await loadMaterializedGoal(ctx, submissionId);

    if (message !== objectivePrompt(draft.objective)) throw new Error("The queued goal prompt does not match its saved preparation.");

    return bindPreparedGoal(draft, ctx, core, captured, false, false, reused, true);
  });
}

function applyDraft(ctx: ExtensionContext, core: GoalCore, target: Goal, objective: string, editing: boolean) {
  if (editing) {
    const goal = core.state.require();
    goal.objective = objective;

    if (goal.status === "complete") core.state.setStatus(ctx, "active");
    core.changed(ctx);
  } else {
    core.state.goal = target;
    core.changed(ctx, goalSetPrompt);
  }
}
