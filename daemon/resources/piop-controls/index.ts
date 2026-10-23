import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPauseControl } from "./pause.ts";
import { forkAndForget, forkSession } from "./fork.ts";
import { publishPauseState, registerControlCommands } from "./commands.ts";
import { registerFastModeControl } from "./fast-mode.ts";
import type { SessionControls } from "./interface.ts";

/** Session controls: pause, resume, stop and forks of the current session, and Piop's fast mode switch. Publishes SessionControls on "piop:controls:session". */
export default function controls(pi: ExtensionAPI) {
  const pause = registerPauseControl(pi, publishPauseState);
  const session: SessionControls = {
    pauseState: () => pause.state(),
    pause: ctx => pause.pause(ctx),
    resume: ctx => pause.resume(ctx),
    stop: ctx => pause.stop(ctx),
    cancelPreparation: () => pause.cancelPreparation(),
    fork: forkSession,
    forkAndForget,
  };
  const unsubscribe = pi.events.on("piop:controls:session", request => { request.session = session; });
  pi.on("session_shutdown", () => { unsubscribe(); });
  registerControlCommands(pi, session);
  registerFastModeControl(pi);
}
