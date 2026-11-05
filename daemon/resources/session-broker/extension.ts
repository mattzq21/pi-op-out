import type { AppRequest } from "../../../pi-extensions/piop-define-agents/contracts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "./subagents.ts";
import { registerConversationClient } from "./client.ts";
import { registerOrchestration } from "./orchestration.ts";
import { registerInputHold, registerQueueHold } from "./holds.ts";
import { registerPromptTools, registerQueueTools, registerToolInventory } from "./tools.ts";
import { registerContextInsertions } from "./context-insertions.ts";
import { registerAuxiliaryChats } from "./auxiliary.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  const key = Symbol.for("piop.runtime-bridge");
  const forward = (request: AppRequest) => pi.events.emit("piop:rpc", request);
  Object.defineProperty(globalThis, key, { value: forward, writable: true, configurable: true });
  pi.on("session_shutdown", () => {
    if (Object.getOwnPropertyDescriptor(globalThis, key)?.value === forward) Reflect.deleteProperty(globalThis, key);
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
