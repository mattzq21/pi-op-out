import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStopControl } from "./stop.ts";
import { forkAndForget, forkSession } from "./fork.ts";
import { registerControlCommands } from "./commands.ts";
import { registerFastModeControl } from "./fast-mode.ts";
import type { SessionControls } from "./interface.ts";

/** Session controls: stop and forks of the current session, and Piop's fast mode switch. Publishes SessionControls on "piop:controls:session". */
export default function controls(pi: ExtensionAPI) {
  const stop = registerStopControl(pi);
  const session: SessionControls = {
    stop: ctx => stop.stop(ctx),
    cancelPreparation: () => stop.cancelPreparation(),
    fork: forkSession,
    forkAndForget,
  };
  const unsubscribe = pi.events.on("piop:controls:session", request => { request.session = session; });
  pi.on("session_shutdown", () => { unsubscribe(); });
  registerControlCommands(pi, session);
  registerFastModeControl(pi);
}
