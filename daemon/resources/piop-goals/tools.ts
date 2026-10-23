import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Goal } from "./state.ts";
import type { GoalCore } from "./preparation.ts";

const goalToolDescription = "Update the existing goal. Set status to `paused` only at the user's explicit request. Report the returned status and stop goal work. Set status to `complete` only when the objective has actually been achieved and no required work remains. This tool cannot resume a goal.";

/** Registers update_goal_status. The user sets goals with /goal, and the goal context tells the agent the objective and status. */
export function registerGoalTools(pi: ExtensionAPI, core: GoalCore) {
  /** The goal as the agent sees it: its objective and status. */
  const result = (ctx: ExtensionContext, completed = false): AgentToolResult<{ goal: Pick<Goal, "objective" | "status"> | null }> => {
    const goal = core.state.response().goal;
    const data = { goal: goal && { objective: goal.objective, status: goal.status } };

    if (completed && goal?.status === "complete") core.state.clear(ctx);
    else core.state.save(ctx);

    return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  };

  pi.registerTool({
    name: "update_goal_status", label: "Update goal", description: goalToolDescription,
    // The model calls it directly; codemode scripts cannot.
    exposure: "model-only",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("paused")]) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return core.coordination.run(ctx, () => {
      signal?.throwIfAborted(); core.assertAvailable(ctx);
      // The model cannot complete or pause an objective it has not seen. The error gives it the edited objective.
      const edit = core.unseenEdit();

      if (edit) { core.markSeen(); throw new Error(edit); }
      core.state.setStatus(ctx, params.status);

      return result(ctx, params.status === "complete");
      });
    },
  });
}
