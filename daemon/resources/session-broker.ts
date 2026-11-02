import type { AppRequest } from "../../extensions/piop-define-agents/contracts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerConversationClient } from "./session-broker/client.ts";
import { registerOrchestration } from "./session-broker/orchestration.ts";
import { registerInputHold } from "./session-broker/input-hold.ts";
import { registerQueueHold } from "./session-broker/queue-hold.ts";
import { registerPromptTools } from "./session-broker/prompt-tools.ts";
import { registerQueueTools } from "./session-broker/queue-tools.ts";
import { registerContextInsertions } from "./session-broker/context-insertions.ts";
import { registerToolInventory } from "./session-broker/tool-inventory.ts";
import { registerAuxiliaryChats } from "./session-broker/auxiliary.ts";
import { existsSync } from "node:fs";
import { initialize } from "./session-broker/session-child-index.cjs";

export { writeSessionFile, publicationRetainsDependencies, type PublicationOptions, type SessionPublication } from "./piop-storage/session-file.ts";

export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  const key = Symbol.for("piop.runtime-bridge");
  const forward = (request: AppRequest) => pi.events.emit("piop:rpc", request);
  Object.defineProperty(globalThis, key, { value: forward, writable: true, configurable: true });
  pi.on("session_shutdown", () => {
    if (Object.getOwnPropertyDescriptor(globalThis, key)?.value === forward) Reflect.deleteProperty(globalThis, key);
  });
  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();

    if (file) await initialize(file, ctx.sessionManager.getSessionId(), !existsSync(file));
  });
  registerInputHold(pi);
  registerQueueHold(pi);
  const promptTools = registerPromptTools(pi);
  registerQueueTools(pi);
  registerContextInsertions(pi);
  registerConversationClient(pi);
  registerOrchestration(pi);
  registerSubagents(pi);
  registerToolInventory(pi, promptTools);
  registerAuxiliaryChats(pi);
}
