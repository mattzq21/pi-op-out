import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Parse } from "typebox/value";
import { forkConversation, type ForkOptions } from "./fork.ts";

const branchRequestSchema = Schema.Object({ entryId: Schema.String() });

const preparationSchema = Schema.Object({ mode: Schema.Union([Schema.Literal("fork"), Schema.Literal("fork_after"), Schema.Literal("clone")]), entryId: Schema.Optional(Schema.String()) });

export type ForkGate = { ready?: Promise<void>; sessionId: string };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:before-fork", handler: (gate: ForkGate) => void): () => void;
    emit(channel: "piop:before-fork", gate: ForkGate): void;
  }
}

type ForkSelection = Pick<ForkOptions, "entryId" | "position"> & { text?: string };

function preparationSelection(ctx: ExtensionContext, preparation: Static<typeof preparationSchema>): ForkSelection {
  const entryId = preparation.mode === "clone" ? ctx.sessionManager.getLeafId() ?? undefined : preparation.entryId;
  const text = preparation.mode === "fork" ? preparationText(ctx, entryId) : undefined;
  const position = preparation.mode === "fork" ? "before" : preparation.mode === "clone" ? "at" : undefined;

  return { entryId, position, text };
}

function preparationText(ctx: ExtensionContext, entryId?: string) {
  const selected = entryId ? ctx.sessionManager.getEntry(entryId) : undefined;

  if (selected?.type !== "message" || selected.message.role !== "user") return;
  const content = selected.message.content;

  return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("") : content;
}

async function prepareFork(pi: ExtensionAPI, ctx: ExtensionContext, preparation: Static<typeof preparationSchema>) {
  if (preparation.mode !== "clone" && !preparation.entryId) throw new Error("Select a message to branch from");
  const selection = preparationSelection(ctx, preparation);
  const sessionId = ctx.sessionManager.getSessionId();
  const source = ctx.sessionManager.getSessionFile();
  const gate: ForkGate = { sessionId };
  pi.events.emit("piop:before-fork", gate);
  await waitForCheckpoints(gate.ready ?? Promise.resolve());

  if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== source) throw new Error("The source conversation changed while its checkpoints were being saved");
  const fork = await forkConversation(ctx, selection, async () => { throw new Error("Unexpected worktree request"); });

  return { ...fork, cancelled: false, text: selection.text };
}

export function registerForkAndForget(pi: ExtensionAPI) {
  pi.events.on("piop:rpc", request => {
    if (request.command !== "prepare_fork") return;
    request.ready = prepareFork(pi, request.ctx, Parse(preparationSchema, request.payload));
  });

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

async function waitForCheckpoints(work: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([work, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Checkpoints did not finish saving before branching. Retry after saving is complete.")), 150_000);
    })]);
  } finally { clearTimeout(timer); }
}
