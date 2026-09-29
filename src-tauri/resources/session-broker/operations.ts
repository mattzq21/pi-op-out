import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { currentHost, request, MESSAGE_TIMEOUT_MS } from "./client.ts";
import { forkConversation, type ForkOptions, type CreatedWorktree } from "./fork.ts";

export function registerForkAndForget(pi: ExtensionAPI) {
  const statusKey = "pi-desktop-control-response";
  pi.registerCommand("pi-desktop-fork-after", {
    description: "Branch after a completed response",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args) as { id?: string; entryId?: string };
        id = request.id;
        if (!id || ctx.mode !== "rpc" || typeof request.entryId !== "string") throw new Error("Invalid branch request");
        const fork = await forkConversation(ctx, { entryId: request.entryId }, async () => { throw new Error("Unexpected worktree request"); });
        const result = await ctx.switchSession(fork.sessionPath);
        ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: true, data: { cancelled: result.cancelled } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(String(error), "error");
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
        const request = JSON.parse(args) as { id?: string; entryId?: string };
        id = request.id;
        if (!id || ctx.mode !== "rpc" || typeof request.entryId !== "string") throw new Error("Invalid fork-and-forget request");
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

export function registerSessionOperations(pi: ExtensionAPI) {
  const create = (ctx: ExtensionContext, name: string, signal?: AbortSignal) => request("/worktrees/create", { hostId: currentHost(), cwd: ctx.cwd, name }, signal, MESSAGE_TIMEOUT_MS) as Promise<CreatedWorktree>;
  const fork = (ctx: ExtensionContext, options: ForkOptions, signal?: AbortSignal) => { signal?.throwIfAborted(); return forkConversation(ctx, options, (name) => create(ctx, name, signal)); };
  const remove = (cwd: string, deleteBranch = false, signal?: AbortSignal) => request("/worktrees/remove", { hostId: currentHost(), cwd, deleteBranch }, signal, MESSAGE_TIMEOUT_MS);
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data });
  pi.registerTool({
    name: "fork_session", label: "Fork conversation",
    description: "Create a separate saved conversation through a completed assistant response. Works with or without Git. Defaults to the latest completed response (empty history if none). Keeps the current agent running. Optionally use another existing directory or create a Git worktree with current files. Returns hostId/sessionId for send_message; does not start the child.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String({ description: "Existing destination directory; defaults to current directory. Files are not copied." })), worktree: Type.Optional(Type.String({ description: "New Git worktree name; mutually exclusive with cwd" })), entryId: Type.Optional(Type.String({ description: "Completed assistant entry on the current branch" })) }),
    async execute(_id, params, signal, _update, ctx) { return result(await fork(ctx, params, signal)); },
  });
  pi.registerTool({
    name: "create_worktree", label: "Create Git worktree", description: "Create a Git branch and worktree from current files, including uncommitted and nonignored untracked files, then run configured setup scripts. Does not create a conversation. Requires a Git project. Setup failures return the kept path and setupError.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, signal, _update, ctx) { return result(await create(ctx, params.name, signal)); },
  });
  pi.registerTool({
    name: "remove_worktree", label: "Remove Git worktree", description: "Remove an unused clean Git worktree after configured cleanup scripts. Refuses the main checkout, dirty worktrees, and worktrees used by conversations or terminals. Branch deletion is optional and never forced.",
    parameters: Type.Object({ cwd: Type.String(), deleteBranch: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) { return result(await remove(resolve(ctx.cwd, params.cwd), params.deleteBranch, signal)); },
  });
  const report = async (ctx: ExtensionContext, operation: () => Promise<unknown>) => {
    try { pi.sendMessage({ customType: "piop-session-operation", content: JSON.stringify(await operation(), null, 2), display: true }, { triggerTurn: false }); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  pi.registerCommand("fork-session", {
    description: 'Fork conversation: /fork-session [directory] or /fork-session --worktree name', handler: async (args, ctx) => report(ctx, () => {
      const value = args.trim();
      if (value === "--worktree") throw new Error("Usage: /fork-session --worktree name");
      return fork(ctx, value.startsWith("--worktree ") ? { worktree: value.slice(11).trim() } : { cwd: value || undefined });
    })
  });
  pi.registerCommand("create-worktree", { description: "Create worktree with current files: /create-worktree name", handler: async (args, ctx) => report(ctx, () => create(ctx, args.trim())) });
  pi.registerCommand("remove-worktree", {
    description: "Remove unused clean worktree, keeping its branch: /remove-worktree path", handler: async (args, ctx) => report(ctx, () => {
      if (!args.trim()) throw new Error("Usage: /remove-worktree path");
      return remove(resolve(ctx.cwd, args.trim()));
    })
  });
}
