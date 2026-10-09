import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequestUserInput } from "./ask-user.ts";
import { registerPauseControl } from "./session-broker/pause.ts";
import { registerFastModeStatus } from "./session-broker/fast-mode.ts";
import { registerForkAndForget } from "./session-broker/operations.ts";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerSubagentMailbox } from "./session-broker/subagent-mailbox.ts";
import { registerBrokerTools } from "./session-broker/tools.ts";
import { registerGoals } from "./session-broker/goals.ts";
import { registerReview } from "./session-broker/review.ts";
import { registerHtmlPreview } from "./session-broker/html-preview.ts";
import { registerOrchestration } from "./session-broker/orchestration.ts";
import { existsSync } from "node:fs";
import { initialize } from "./session-broker/session-child-index.cjs";

export { desktopPauseContext, registerPauseControl, type PauseController } from "./session-broker/pause.ts";

export { registerFastModeStatus } from "./session-broker/fast-mode.ts";

export { forkConversation } from "./session-broker/fork.ts";

export { writeSessionFile, publicationRetainsDependencies, type PublicationOptions, type SessionPublication } from "./session-broker/session-file.ts";

export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();

    if (file) await initialize(file, ctx.sessionManager.getSessionId(), !existsSync(file));
  });
  registerPauseControl(pi);
  registerFastModeStatus(pi);
  registerForkAndForget(pi);
  const mailbox = registerSubagentMailbox(pi);
  registerOrchestration(pi);
  registerSubagents(pi, mailbox);
  registerRequestUserInput(pi);
  registerBrokerTools(pi);
  registerGoals(pi);
  registerReview(pi);
  registerHtmlPreview(pi);
}
