import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";
import { forkConversation } from "./fork.ts";

const branchRequestSchema = Schema.Object({ id: Schema.String(), entryId: Schema.String() });

const requestIdSchema = Schema.Object({ id: Schema.String() });

export function registerForkAndForget(pi: ExtensionAPI) {
  const statusKey = "pi-desktop-control-response";
  pi.registerCommand("pi-desktop-fork-after", {
    description: "Branch after a completed response",
    async handler(args, ctx) {
      let id: string | undefined;
      let responseContext: ExtensionContext = ctx;

      try {
        const request = JSON.parse(args);
        id = Check(requestIdSchema, request) ? request.id : undefined;

        if (!id || ctx.mode !== "rpc" || !Check(branchRequestSchema, request)) throw new Error("Invalid branch request");
        const fork = await forkConversation(ctx, { entryId: request.entryId }, async () => { throw new Error("Unexpected worktree request"); });
        const result = await ctx.switchSession(fork.sessionPath, { withSession: async next => { responseContext = next; } });
        responseContext.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: true, data: { cancelled: result.cancelled } })}`);
      } catch (error) {
        if (id) responseContext.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else responseContext.ui.notify(String(error), "error");
      }
    },
  });

  const assertAssistantEntry = (ctx: ExtensionContext, entryId: string) => {
    const entry = ctx.sessionManager.getEntry(entryId);

    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Assistant response not found in this conversation");
  };

  pi.registerCommand("pi-desktop-fork-and-forget", {
    description: "Continue this session from an earlier assistant response",
    async handler(args, ctx) {
      let id: string | undefined;

      try {
        const request = JSON.parse(args);
        id = Check(requestIdSchema, request) ? request.id : undefined;

        if (!id || ctx.mode !== "rpc" || !Check(branchRequestSchema, request)) throw new Error("Invalid fork-and-forget request");
        assertAssistantEntry(ctx, request.entryId);
        const result = await ctx.navigateTree(request.entryId);

        if (!result.cancelled) pi.appendEntry("pi-desktop-fork-and-forget", { entryId: request.entryId });
        ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: true, data: { cancelled: result.cancelled } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
