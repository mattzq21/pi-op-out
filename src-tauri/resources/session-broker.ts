import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequestUserInput } from "./ask-user.ts";
import { registerPauseControl } from "./session-broker/pause.ts";
import { registerFastModeStatus } from "./session-broker/fast-mode.ts";
import { registerTurnCapture } from "./session-broker/turn-capture.ts";
import { registerCatchUp } from "./session-broker/catch-up.ts";
import { registerForkAndForget, registerSessionOperations } from "./session-broker/operations.ts";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerBrokerTools } from "./session-broker/tools.ts";

export { desktopPauseContext, registerPauseControl, type PauseController } from "./session-broker/pause.ts";
export { registerFastModeStatus } from "./session-broker/fast-mode.ts";
export { registerCatchUp } from "./session-broker/catch-up.ts";
export { forkConversation } from "./session-broker/fork.ts";
export { registerSessionOperations } from "./session-broker/operations.ts";
export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  registerTurnCapture(pi);
  registerCatchUp(pi);
  registerPauseControl(pi);
  registerFastModeStatus(pi);
  registerForkAndForget(pi);
  registerSessionOperations(pi);
  registerSubagents(pi);
  registerRequestUserInput(pi);
  registerBrokerTools(pi);
}
