import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { SessionAgentState } from "../../../extensions/piop-define-agents/contracts.ts";
import type { FastModeSession, FastModeSessionRequest } from "../../../extensions/piop-openai-fast-mode/src/types.ts";

const statusKey = "pi-desktop-fast-mode";

/** The fast mode extension's saved choice entry. */
const STATE_ENTRY = "piop-fast-mode-state";

/** The fast mode extension's session interface, or undefined when the extension is not loaded. */
export function fastModeSession(pi: ExtensionAPI): FastModeSession | undefined {
  const request: FastModeSessionRequest = {};
  pi.events.emit("piop:fast-mode:session", request);

  return request.session;
}

/**
 * The saved choice entry for a new child session. An explicitly selected profile uses its fast mode default when it has one;
 * otherwise the child inherits this session's choice. Returns undefined when the fast mode extension is not loaded.
 */
export async function childFastModeEntry(pi: ExtensionAPI, profile: SessionAgentState, explicit: boolean) {
  const session = fastModeSession(pi);
  const declared = explicit ? profile.snapshot?.definition.fastMode : undefined;

  if (!session) return undefined;

  return { type: "custom" as const, customType: STATE_ENTRY, data: { enabled: declared ?? await session.getEnabled() } };
}

/** Publishes the session's fast mode choice to piop and applies client changes through the session interface. */
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
