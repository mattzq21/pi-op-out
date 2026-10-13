import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerSubagentMailbox } from "./session-broker/subagent-mailbox.ts";
import { registerConversationClient } from "./session-broker/client.ts";
import { registerOrchestration } from "./session-broker/orchestration.ts";
import { existsSync } from "node:fs";
import { initialize } from "./session-broker/session-child-index.cjs";

export { writeSessionFile, publicationRetainsDependencies, type PublicationOptions, type SessionPublication } from "./session-broker/session-file.ts";

export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();

    if (file) await initialize(file, ctx.sessionManager.getSessionId(), !existsSync(file));
  });
  registerConversationClient(pi);
  const mailbox = registerSubagentMailbox(pi);
  registerOrchestration(pi);
  registerSubagents(pi, mailbox);
}
