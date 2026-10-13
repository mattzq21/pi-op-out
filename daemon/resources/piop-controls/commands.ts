import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import type { PauseState, SessionControls } from "./interface.ts";

const controlSchema = Schema.Object({ action: Schema.String() });

const branchRequestSchema = Schema.Object({ entryId: Schema.String() });

const preparationSchema = Schema.Object({ mode: Schema.Union([Schema.Literal("fork"), Schema.Literal("fork_after"), Schema.Literal("clone")]), entryId: Schema.Optional(Schema.String()) });

/** Sends the pause state to Piop. */
export function publishPauseState(ctx: ExtensionContext, state: PauseState) {
  ctx.ui.setStatus("pi-desktop-pause-state", `json:${JSON.stringify({ type: "pause_state", ...state })}`);
}

/** Connects Piop control and fork requests to the session controls. */
export function registerControlCommands(pi: ExtensionAPI, controls: SessionControls) {
  const applyControl = async (action: string, ctx: ExtensionContext) => {
    if (action === "pause") await controls.pause(ctx);
    else if (action === "resume") return controls.resume(ctx);
    else if (action === "stop") await controls.stop(ctx);
    else if (action === "cancel-preparation") controls.cancelPreparation();
    else if (action !== "state") throw new Error(`Unknown desktop control: ${action}`);
  };

  pi.events.on("piop:rpc", request => {
    if (request.command !== "control") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const control = Parse(controlSchema, request.payload);
      const resumeMessage = await applyControl(control.action, ctx);
      const state = controls.pauseState();

      return resumeMessage ? { ...state, resumeMessage } : state;
    })();
  });

  pi.events.on("piop:rpc", request => {
    if (request.command !== "prepare_fork") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const preparation = Parse(preparationSchema, request.payload);

      return { ...await controls.fork(ctx, preparation.mode, preparation.entryId), cancelled: false };
    })();
  });

  pi.events.on("piop:rpc", request => {
    if (request.command !== "fork_after") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const branch = Parse(branchRequestSchema, request.payload);
      const fork = await controls.fork(ctx, "fork_after", branch.entryId);

      return ctx.switchSession(fork.sessionPath);
    })();
  });

  pi.events.on("piop:rpc", request => {
    if (request.command !== "fork_and_forget") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const branch = Parse(branchRequestSchema, request.payload);

      return controls.forkAndForget(ctx, branch.entryId);
    })();
  });
}
