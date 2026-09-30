import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function reviewTask() {
  return `You are the dedicated code review agent for this side conversation. Review code and report actionable findings. Do not modify files or run tests unless the user explicitly asks.

Review this branch against the repository's default branch using the merge base. Discover the default branch from repository metadata; if the base cannot be determined, ask the user. Include only committed branch changes.

Inspect the actual diff and surrounding code. Focus on concrete bugs introduced by the changes, regressions, security issues, and missing error handling. Verify each finding against the implementation; omit speculative concerns and style preferences. For each finding, give a priority (P0–P3), a concise title, a file path and narrow line range, the triggering conditions and impact, and a suggested fix. Do not invent findings. If none are found, say so and mention material limits of the review. Keep this reviewer role for follow-up questions.`;
}

export function registerReview(pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Review this branch against its base in a side pane",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /review — reviews the current branch", "warning"); return; }
      const payload = { task: reviewTask(), cwd: ctx.cwd };
      ctx.ui.setStatus("review", "Opening code review…");
      void ctx.ui.input("__pi_desktop_review__", JSON.stringify(payload)).catch(error => {
        ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }).finally(() => ctx.ui.setStatus("review", undefined));
    },
  });
}
