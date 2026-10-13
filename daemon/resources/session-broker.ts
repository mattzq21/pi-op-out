import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequestUserInput } from "./ask-user.ts";
import { registerPauseControl } from "./session-broker/pause.ts";
import { registerFastModeControl } from "./session-broker/fast-mode.ts";
import { registerContextCapDefaults } from "./session-broker/context-cap.ts";
import { registerForkAndForget } from "./session-broker/operations.ts";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerSubagentMailbox } from "./session-broker/subagent-mailbox.ts";
import { registerGoals } from "./session-broker/goals.ts";
import { registerReview } from "./session-broker/review.ts";
import { registerHtmlPreview } from "./session-broker/html-preview.ts";
import { registerConversationClient } from "./session-broker/client.ts";
import { registerOrchestration } from "./session-broker/orchestration.ts";
import { existsSync } from "node:fs";
import { initialize } from "./session-broker/session-child-index.cjs";

export { desktopPauseContext, registerPauseControl, type PauseController } from "./session-broker/pause.ts";

export { registerFastModeControl } from "./session-broker/fast-mode.ts";

export { forkConversation } from "./session-broker/fork.ts";

export { writeSessionFile, publicationRetainsDependencies, type PublicationOptions, type SessionPublication } from "./session-broker/session-file.ts";

export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();

    if (file) await initialize(file, ctx.sessionManager.getSessionId(), !existsSync(file));
  });
  registerConversationClient(pi);
  registerPauseControl(pi);
  registerFastModeControl(pi);
  registerContextCapDefaults(pi);
  registerForkAndForget(pi);
  const mailbox = registerSubagentMailbox(pi);
  registerOrchestration(pi);
  registerSubagents(pi, mailbox);
  registerRequestUserInput(pi);
  registerGoals(pi);
  registerReview(pi);
  registerHtmlPreview(pi);
}
