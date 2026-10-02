import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import { forkConversation } from "./fork.ts";

const branchRequestSchema = Schema.Object({ entryId: Schema.String() });

export function registerForkAndForget(pi: ExtensionAPI) {
  pi.events.on("piop:rpc", request => {
    if (request.command !== "fork_after") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const branch = Parse(branchRequestSchema, request.payload);
      const fork = await forkConversation(ctx, { entryId: branch.entryId }, async () => { throw new Error("Unexpected worktree request"); });

      return ctx.switchSession(fork.sessionPath);
    })();
  });

  const assertAssistantEntry = (ctx: ExtensionContext, entryId: string) => {
    const entry = ctx.sessionManager.getEntry(entryId);

    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Assistant response not found in this conversation");
  };

  pi.events.on("piop:rpc", request => {
    if (request.command !== "fork_and_forget") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const branch = Parse(branchRequestSchema, request.payload);
      assertAssistantEntry(ctx, branch.entryId);
      const result = await ctx.navigateTree(branch.entryId);

      if (!result.cancelled) pi.appendEntry("pi-desktop-fork-and-forget", { entryId: branch.entryId });

      return result;
    })();
  });
}
