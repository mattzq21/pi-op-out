import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { GoalState } from "./state.ts";
import type { GoalCore } from "./preparation.ts";

const goalToolDescription = "Update the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.";

/** Registers get_goal, create_goal and update_goal. */
export function registerGoalTools(pi: ExtensionAPI, core: GoalCore) {
  const result = (ctx: ExtensionContext, completed = false): AgentToolResult<ReturnType<GoalState["response"]>> => {
    const data = core.state.response(completed);

    if (completed && data.goal?.status === "complete") core.state.clear(ctx);
    else core.state.save(ctx);

    return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  };

  pi.registerTool({
    name: "get_goal", label: "Get goal", description: "Get the current goal, including status, budget, token and elapsed-time usage, and remaining token budget.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      return core.coordination.run(ctx, () => { signal?.throwIfAborted(); core.assertAvailable(ctx);

      return result(ctx); });
    },
  });
  pi.registerTool({
    name: "create_goal", label: "Create goal", description: "Create a goal only when explicitly requested by the user or system/developer instructions; never infer goals from ordinary tasks. Set token_budget only when explicitly requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object({ objective: Type.String(), token_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return core.coordination.run(ctx, () => {
      signal?.throwIfAborted(); core.assertAvailable(ctx);
      core.state.create(ctx, params.objective, params.token_budget ?? null);

      return result(ctx);
      });
    },
  });
  pi.registerTool({
    name: "update_goal", label: "Update goal", description: goalToolDescription,
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")]) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return core.coordination.run(ctx, () => {
      signal?.throwIfAborted(); core.assertAvailable(ctx);
      core.state.setStatus(ctx, params.status); core.state.finishRun();

      return result(ctx, params.status === "complete");
      });
    },
  });
}
