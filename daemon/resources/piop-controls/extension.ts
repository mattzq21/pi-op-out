import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStopControl } from "./stop.ts";
import { forkSession, rewindMessage } from "./fork.ts";
import { copyAuxiliary } from "./auxiliary-copy.ts";
import { registerControlCommands } from "./commands.ts";
import { registerFastModeControl } from "./fast-mode.ts";
import type { SessionControls } from "./interface.ts";

export default function controls(pi: ExtensionAPI) {
  const stop = registerStopControl(pi);
  const session: SessionControls = {
    stop: ctx => stop.stop(ctx),
    cancelPreparation: () => stop.cancelPreparation(),
    fork: forkSession,
    copyAuxiliary,
    rewindMessage,
  };
  const unsubscribe = pi.events.on("piop:controls:session", request => { request.session = session; });
  pi.on("session_shutdown", () => { unsubscribe(); });
  registerControlCommands(pi, session);
  registerFastModeControl(pi);
}
