import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Parse } from "typebox/value";
import { goalImagesSchema, goalPreparationView } from "./files.ts";
import { objectivePrompt, prepareGoal, resumePreparedGoal, type GoalCore } from "./preparation.ts";
import type { GoalReport, GoalSession } from "./interface.ts";

const USAGE = "/goal [objective|edit|pause|resume|clear|budget <tokens|clear>]";

const promptSchema = Schema.Object({ message: Schema.String(), goalSubmissionId: Schema.Optional(Schema.String()), images: Schema.Optional(goalImagesSchema), prepared: Schema.Optional(Schema.Boolean()) });

const preparationRequestSchema = Schema.Object({ goalSubmissionId: Schema.String() });

const isGoalObjective = (value: string) => Boolean(value) && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ");

function goalObjective(text: string) {
  const value = text.trimStart().match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();

  return value !== undefined && isGoalObjective(value) ? value : undefined;
}

function promptGoalObjective(message: string, images: Static<typeof goalImagesSchema>) {
  return goalObjective(message) ?? (images.length && message.trim() === "/goal" ? "" : undefined);
}

function goalSummary({ goal, remainingTokens }: GoalReport) {
  if (!goal) return `No goal is set. ${USAGE}`;
  const budget = goal.tokenBudget === null ? `${goal.tokensUsed.toLocaleString()} used; no limit` : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} (${remainingTokens?.toLocaleString()} remaining)`;

  return `Goal ${goal.status.replaceAll("_", " ")}\n\n${goal.objective}\n\nTokens: ${budget}\nActive time: ${goal.timeUsedSeconds}s\n\n${USAGE}`;
}

/** Runs /goal arguments other than a new objective. */
async function runGoalCommand(value: string, ctx: ExtensionContext, session: GoalSession, core: GoalCore): Promise<GoalReport | undefined> {
  switch (value) {
    case "": return session.report(ctx);
    case "edit": return (await prepareGoal(value, ctx, core, true))?.report;
    case "clear": return session.clear(ctx);
    case "pause": return session.pause(ctx);
    case "resume": return session.resume(ctx);
    default:
      if (!value.startsWith("budget ")) throw new Error(USAGE);
      const budget = value.slice(7).trim();

      return session.setBudget(ctx, budget === "clear" ? null : Number(budget));
  }
}

/** Connects the /goal command and Piop goal input requests to the goal feature. */
export function registerGoalCommands(pi: ExtensionAPI, session: GoalSession, core: GoalCore) {
  const preparePrompt = async (message: string, ctx: ExtensionContext, submissionId?: string, images: Static<typeof goalImagesSchema> = [], saved = false) => {
    if (/^\/goal(?:\s|$)/.test(message.trimStart()) && images.length) throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
    const value = promptGoalObjective(message, images);

    if (value === undefined && !saved) return { message };

    try {
      const prepared = saved ? await resumePreparedGoal(message, ctx, core, submissionId) : await prepareGoal(value ?? "", ctx, core, false, false, submissionId, images);

      if (!prepared) throw new Error("Goal submission cancelled. The objective was not submitted.");

      return { message: objectivePrompt(prepared.objective), goalSubmissionId: prepared.goalSubmissionId, accept: prepared.accept };
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
          await prepareGoal(value, ctx, core, false);

          return;
        }

        const report = await runGoalCommand(value, ctx, session, core);

        if (report && value !== "clear") pi.sendMessage({ customType: "piop-goal-summary", content: goalSummary(report), display: true }, { triggerTurn: false });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
