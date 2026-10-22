import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Parse } from "typebox/value";
import { goalImagesSchema, goalPreparationView } from "../piop-storage/goal-files.ts";
import { objectivePrompt, prepareGoal, resumePreparedGoal, type GoalCore } from "./preparation.ts";
import type { GoalSession } from "./interface.ts";

const USAGE = "/goal <objective | edit | pause | resume | clear>";

const promptSchema = Schema.Object({ message: Schema.String(), goalSubmissionId: Schema.Optional(Schema.String()), images: Schema.Optional(goalImagesSchema), prepared: Schema.Optional(Schema.Boolean()) });

const preparationRequestSchema = Schema.Object({ goalSubmissionId: Schema.String() });

const isGoalObjective = (value: string) => Boolean(value) && !["edit", "clear", "pause", "resume"].includes(value);

function goalObjective(text: string) {
  const value = text.trimStart().match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();

  return value !== undefined && isGoalObjective(value) ? value : undefined;
}

function promptGoalObjective(message: string, images: Static<typeof goalImagesSchema>) {
  return goalObjective(message) ?? (images.length && message.trim() === "/goal" ? "" : undefined);
}

/** Runs /goal arguments other than a new objective. /goal without an argument is an error. */
async function runGoalCommand(value: string, ctx: ExtensionContext, session: GoalSession, core: GoalCore) {
  switch (value) {
    case "edit": await prepareGoal(value, ctx, core, true); return;
    case "clear": await session.clear(ctx); return;
    case "pause": await session.pause(ctx); return;
    case "resume": await session.resume(ctx); return;
    default: throw new Error(`Write an objective or an action after /goal. Usage: ${USAGE}`);
  }
}

/** Connects the /goal command and Piop goal input requests to the goal feature. */
export function registerGoalCommands(pi: ExtensionAPI, session: GoalSession, core: GoalCore) {
  /** Goal messages that were prepared and may now reach the model. Each passes the input check once. */
  const prepared = new Set<string>();
  const preparePrompt = async (message: string, ctx: ExtensionContext, submissionId?: string, images: Static<typeof goalImagesSchema> = [], saved = false) => {
    if (/^\/goal(?:\s|$)/.test(message.trimStart()) && images.length) throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
    const value = promptGoalObjective(message, images);

    if (value === undefined && !saved) return { message };

    try {
      const result = saved ? await resumePreparedGoal(message, ctx, core, submissionId) : await prepareGoal(value ?? "", ctx, core, false, false, submissionId, images);

      if (!result) throw new Error("Goal submission cancelled. The objective was not submitted.");

      const goalMessage = objectivePrompt(result.objective);
      prepared.add(goalMessage);

      return { message: goalMessage, goalSubmissionId: result.goalSubmissionId, accept: result.accept };
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
    if (goalObjective(event.text) === undefined || prepared.delete(event.text)) return;

    ctx.ui.notify("Goal input was not prepared before dispatch. Restore the objective from saved input recovery and retry.", "error");

    return { action: "handled" };
  });
  pi.registerCommand("goal", {
    description: `Persistent conversation goal. ${USAGE}`,
    getArgumentCompletions: prefix => [...(prefix.trim() ? [] : [{ value: "", label: "<objective | edit | pause | resume | clear>" }]), ...["edit", "pause", "resume", "clear"].flatMap(value => value.startsWith(prefix.trim()) ? [{ value, label: value }] : [])],
    async handler(args, ctx) {
      try {
        const value = args.trim();

        if (isGoalObjective(value)) {
          await prepareGoal(value, ctx, core, false);

          return;
        }

        await runGoalCommand(value, ctx, session, core);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
