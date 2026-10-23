import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import type { ReviewDelegation, ReviewImage, ReviewSession } from "./interface.ts";

const reviewRequestSchema = Schema.Object({ command: Schema.Optional(Schema.Union([Schema.Literal("review"), Schema.Literal("rs")])), args: Schema.String(), images: Schema.Array(Schema.Object({ type: Schema.Literal("image"), data: Schema.String(), mimeType: Schema.String(), name: Schema.Optional(Schema.String()) })) });

const feedbackSchema = Schema.Object({ sessionId: Schema.String(), message: Schema.String({ minLength: 1 }) });

const openSchema = Schema.Object({ reviewId: Schema.String() });

/** /review delegates nothing and takes a scope. /rs takes an optional count, then an optional scope. A first word that is a number is the count; other text is the scope. Returns undefined after a usage warning for a count that is not a positive integer. */
function reviewRequest(args: string, command: "review" | "rs", ctx: ExtensionContext): { delegation: ReviewDelegation; scope: string } | undefined {
  const text = args.trim();

  if (command === "review") return { delegation: "none", scope: text };
  const [, first, rest = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text) ?? [];

  if (!first || !/^[+-]?\d+$/.test(first)) return { delegation: "auto", scope: text };
  const count = Number(first);

  if (/^[1-9]\d*$/.test(first) && Number.isSafeInteger(count)) return { delegation: count, scope: rest.trim() };
  ctx.ui.notify("Usage: /rs [n] [scope] — n is a positive number of review subagents", "warning");
}

/** Connects /review, /rs and Piop review requests to the review feature. */
export function registerReviewCommands(pi: ExtensionAPI, reviews: ReviewSession) {
  const start = async (args: string, ctx: ExtensionContext, command: "review" | "rs" = "review", images?: ReviewImage[]) => {
    ctx.signal?.throwIfAborted();
    const request = reviewRequest(args, command, ctx);

    if (request === undefined) return;
    await reviews.start(ctx, { scope: request.scope || undefined, delegation: request.delegation, images });
  };

  pi.registerCommand("review", {
    description: "Review files in the current directory in a side pane",
    getArgumentCompletions: prefix => prefix.trim() ? null : [{ value: "", label: "[scope]", description: "Optional. Text that limits the review, for example files or a feature" }],
    handler: (args, ctx) => start(args, ctx),
  });
  pi.registerCommand("rs", {
    description: "Review with review subagents: /rs [n] [scope]",
    getArgumentCompletions: prefix => prefix.trim() ? null : [{ value: "", label: "[n] [scope]", description: "Optional. Number of review subagents, then text that limits the review" }],
    handler: (args, ctx) => start(args, ctx, "rs"),
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "run_queued_command" || !["review", "rs"].includes(request.payload?.command)) return;
    request.ready = (async () => {
      const payload = Parse(reviewRequestSchema, request.payload);
      await start(payload.args, request.ctx, payload.command, payload.images);
    })();
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "open_review") return;
    request.ready = (async () => {
      const { reviewId } = Parse(openSchema, request.payload);
      await reviews.open(request.ctx, reviewId);
    })();
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "review_feedback") return;
    request.ready = (async () => {
      const feedback = Parse(feedbackSchema, request.payload);
      await reviews.sendFeedback(request.ctx, feedback.sessionId, feedback.message);
    })();
  });
}
