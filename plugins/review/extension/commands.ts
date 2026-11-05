import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import type { ReviewImage, ReviewSession } from "./interface.ts";

const reviewRequestSchema = Schema.Object({ command: Schema.Optional(Schema.Literal("review")), args: Schema.String(), images: Schema.Array(Schema.Object({ type: Schema.Literal("image"), data: Schema.String(), mimeType: Schema.String(), name: Schema.Optional(Schema.String()) })) });

export function registerReviewCommands(pi: ExtensionAPI, reviews: ReviewSession) {
  const start = async (args: string, ctx: ExtensionContext, images?: ReviewImage[]) => {
    ctx.signal?.throwIfAborted();
    await reviews.start(ctx, { scope: args.trim() || undefined, images });
  };

  pi.registerCommand("review", {
    description: "Review files in the current directory in a side pane",
    getArgumentCompletions: prefix => prefix.trim() ? null : [{ value: "", label: "[scope]", description: "Optional. Text that limits the review, for example files or a feature" }],
    handler: (args, ctx) => start(args, ctx),
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "run_command" || request.payload?.command !== "review") return;
    request.ready = (async () => {
      const payload = Parse(reviewRequestSchema, request.payload);
      await start(payload.args, request.ctx, payload.images);
    })();
  });
}
