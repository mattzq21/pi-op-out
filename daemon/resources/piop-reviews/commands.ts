import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import type { ReviewDelegation, ReviewImage, ReviewSession } from "./interface.ts";

const reviewRequestSchema = Schema.Object({ command: Schema.Optional(Schema.Union([Schema.Literal("review"), Schema.Literal("rs")])), args: Schema.String(), images: Schema.Array(Schema.Object({ type: Schema.Literal("image"), data: Schema.String(), mimeType: Schema.String(), name: Schema.Optional(Schema.String()) })) });

const feedbackSchema = Schema.Object({ sessionId: Schema.String(), message: Schema.String({ minLength: 1 }) });

const openSchema = Schema.Object({ reviewId: Schema.String() });

/** /review delegates nothing. /rs takes an optional positive count; returns undefined after a usage warning for other arguments. */
function reviewDelegation(args: string, command: "review" | "rs", ctx: ExtensionContext): ReviewDelegation | undefined {
  if (command === "review") return "none";

  if (!args.trim()) return "auto";
  const count = Number(args.trim());

  if (/^[1-9]\d*$/.test(args.trim()) && Number.isSafeInteger(count)) return count;
  ctx.ui.notify("Usage: /rs [n] — omit n for proportionate delegation, or supply a positive integer", "warning");
}

/** Connects /review, /rs and Piop review requests to the review feature. */
export function registerReviewCommands(pi: ExtensionAPI, reviews: ReviewSession) {
  const start = async (args: string, ctx: ExtensionContext, command: "review" | "rs" = "review", images?: ReviewImage[]) => {
    ctx.signal?.throwIfAborted();
    const delegation = reviewDelegation(args, command, ctx);

    if (delegation === undefined) return;
    await reviews.start(ctx, { scope: command === "review" ? args : undefined, delegation, images });
  };

  pi.registerCommand("review", {
    description: "Review files in the current directory in a side pane",
    handler: (args, ctx) => start(args, ctx),
  });
  pi.registerCommand("rs", {
    description: "Review with proportionate delegation, or an explicit subagent count: /rs [n]",
    handler: (args, ctx) => start(args, ctx, "rs"),
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "start_review") return;
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
