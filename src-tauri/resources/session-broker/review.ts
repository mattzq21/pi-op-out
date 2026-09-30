import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

function registerReviewMessaging(pi: ExtensionAPI) {
  let reviewerId: string | undefined;
  const isReviewer = (ctx: ExtensionContext) => reviewerId === ctx.sessionManager.getSessionId();
  const stop = pi.events.on("piop:required-tools", value => {
    const request = value as { ctx: ExtensionContext; tools: string[] };
    if (isReviewer(request.ctx)) request.tools.push("message_main_chat");
  });
  pi.on("session_shutdown", stop);
  pi.on("session_start", () => { reviewerId = undefined; });
  pi.registerCommand("pi-orchestration-review-init", {
    description: "Initialize a temporary reviewer",
    handler: async (_args, ctx) => {
      if (ctx.sessionManager.getSessionFile()) throw new Error("Reviewer tools require a temporary review session");
      reviewerId = ctx.sessionManager.getSessionId();
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "message_main_chat"])]);
    },
  });
  pi.registerTool({
    name: "message_main_chat", label: "Message main chat",
    description: "Send review findings or a question to the main chat that opened this reviewer. Queues the message if the main agent is busy. Returns after delivery without waiting for a reply.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!isReviewer(ctx)) throw new Error("This tool is only available to the reviewer");
      if (!params.message.trim()) throw new Error("A message is required");
      const result = await ctx.ui.input("__piop_review_message_main__", JSON.stringify({ message: params.message }), { signal });
      if (result !== "delivered") throw new Error(result || "Message delivery cancelled");
      return { content: [{ type: "text", text: "Message delivered to the main chat." }], details: {} };
    },
  });
}

function reviewTask() {
  return `You are the dedicated code review agent for this side conversation. Review code and report actionable findings. Do not modify files or run tests unless the user explicitly asks.

Review this branch against the repository's default branch using the merge base. Discover the default branch from repository metadata; if the base cannot be determined, ask the user. Include only committed branch changes.

Inspect the actual diff and surrounding code. Focus on concrete bugs introduced by the changes, regressions, security issues, and missing error handling. Verify each finding against the implementation; omit speculative concerns and style preferences. For each finding, give a priority (P0–P3), a concise title, a file path and narrow line range, the triggering conditions and impact, and a suggested fix. Do not invent findings. If none are found, say so and mention material limits of the review. Keep this reviewer role for follow-up questions.`;
}

export function registerReview(pi: ExtensionAPI) {
  registerReviewMessaging(pi);
  pi.registerCommand("review", {
    description: "Review this branch against its base in a side pane",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /review — reviews the current branch", "warning"); return; }
      const payload = { task: reviewTask(), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId() };
      ctx.ui.setStatus("review", "Opening code review…");
      void ctx.ui.input("__pi_desktop_review__", JSON.stringify(payload)).catch(error => {
        ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }).finally(() => ctx.ui.setStatus("review", undefined));
    },
  });
}
