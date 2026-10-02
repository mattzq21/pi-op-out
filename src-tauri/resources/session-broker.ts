import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { registerRequestUserInput } from "./ask-user.ts";
import { registerPauseControl } from "./session-broker/pause.ts";
import { registerFastModeStatus } from "./session-broker/fast-mode.ts";
import { registerTurnCapture } from "./session-broker/turn-capture.ts";
import { registerForkAndForget } from "./session-broker/operations.ts";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerBrokerTools } from "./session-broker/tools.ts";
import { registerGoals } from "./session-broker/goals.ts";
import { registerReview } from "./session-broker/review.ts";
import { registerHtmlPreview } from "./session-broker/html-preview.ts";

export { desktopPauseContext, registerPauseControl, type PauseController } from "./session-broker/pause.ts";

export { registerFastModeStatus } from "./session-broker/fast-mode.ts";

export { forkConversation } from "./session-broker/fork.ts";

export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    let root: string | null = null;

    try {
      const { stdout } = await promisify(execFile)("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
      root = await realpath(stdout.trimEnd());
    } catch {}

    ctx.ui.setStatus("pi-desktop-worktree-root", JSON.stringify(root));
  });
  registerTurnCapture(pi);
  registerPauseControl(pi);
  registerFastModeStatus(pi);
  registerForkAndForget(pi);
  registerSubagents(pi);
  registerRequestUserInput(pi);
  registerBrokerTools(pi);
  registerGoals(pi);
  registerReview(pi);
  registerHtmlPreview(pi);
}
