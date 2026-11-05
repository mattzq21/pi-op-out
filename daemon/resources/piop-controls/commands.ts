import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import type { SessionControls } from "./index.ts";
import { fastModeSession } from "../session-broker/index.ts";

const controlSchema = Schema.Object({ action: Schema.String() });

const branchRequestSchema = Schema.Object({ entryId: Schema.String() });

const rewindRequestSchema = Schema.Object({ entryId: Schema.String(), keep: Schema.Array(Schema.Integer({ minimum: 0 })) });

const preparationSchema = Schema.Object({ mode: Schema.Union([Schema.Literal("fork"), Schema.Literal("fork_after"), Schema.Literal("clone")]), entryId: Schema.Optional(Schema.String()) });

export function registerControlCommands(pi: ExtensionAPI, controls: SessionControls) {
  const applyControl = async (action: string, ctx: ExtensionContext) => {
    if (action === "stop") await controls.stop(ctx);
    else if (action === "cancel-preparation") controls.cancelPreparation();
    else throw new Error(`Unknown desktop control: ${action}`);
  };

  pi.events.on("piop:rpc", request => {
    if (request.command !== "control") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      await applyControl(Parse(controlSchema, request.payload).action, ctx);

      return null;
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
    if (request.command !== "rewind_message") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const rewind = Parse(rewindRequestSchema, request.payload);

      return controls.rewindMessage(ctx, rewind.entryId, rewind.keep);
    })();
  });
}

const statusKey = "pi-desktop-fast-mode";

export function registerFastModeControl(pi: ExtensionAPI) {
  let stop: (() => void) | undefined;

  const watch = (ctx: ExtensionContext) => {
    stop?.();
    stop = undefined;

    if (ctx.mode !== "rpc") return;
    const session = fastModeSession(pi);

    if (!session) { ctx.ui.setStatus(statusKey, undefined);

    return; }

    stop = session.subscribe(enabled => ctx.ui.setStatus(statusKey, enabled ? "Fast mode on" : "Fast mode off"), error => {
      ctx.ui.setStatus(statusKey, "Fast mode status unavailable");
      ctx.ui.notify("Fast mode status unavailable: " + error.message, "error");
    });
  };

  pi.events.on("piop:rpc", request => {
    if (request.command !== "set_fast_mode") return;
    request.ready = (async () => {
      const { enabled } = Parse(Schema.Object({ enabled: Schema.Boolean() }), request.payload);
      const session = fastModeSession(pi);

      if (!session) throw new Error("Fast mode is unavailable in this conversation");
      await session.setEnabled(enabled);

      return null;
    })();
  });
  pi.on("session_start", (_event, ctx) => watch(ctx));
  pi.on("session_shutdown", () => { stop?.(); stop = undefined; });
}
