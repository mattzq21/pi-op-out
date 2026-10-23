import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { fastModeSession } from "../session-broker/fast-mode.ts";

const statusKey = "pi-desktop-fast-mode";

/** Publishes the session's fast mode choice to Piop and applies Piop changes through the fast mode extension's session interface. */
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
      const { enabled } = Parse(Type.Object({ enabled: Type.Boolean() }), request.payload);
      const session = fastModeSession(pi);

      if (!session) throw new Error("Fast mode is unavailable in this conversation");
      await session.setEnabled(enabled);

      return null;
    })();
  });
  pi.on("session_start", (_event, ctx) => watch(ctx));
  pi.on("session_shutdown", () => { stop?.(); stop = undefined; });
}
