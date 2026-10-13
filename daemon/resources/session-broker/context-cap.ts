import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextCapSessionRequest } from "../../../extensions/piop-context-window-cap/channel.ts";
import type { ContextCapSettings } from "../../../extensions/piop-context-window-cap/interface.ts";
import type { AgentSelectedEvent } from "../../../extensions/piop-define-agents/contracts.ts";
import { readFile } from "./app-settings.cjs";

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:ready", handler: (event: AgentSelectedEvent) => void): () => void;
    emit(channel: "piop:agents:ready", event: AgentSelectedEvent): void;
  }
}

export function registerContextCapSettings(pi: ExtensionAPI, load = (): ContextCapSettings => {
  const path = process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH;
  if (!path) throw new Error("Context cap settings path is unavailable");
  return readFile(path);
}) {
  let closed = false;
  const apply = async (ctx: ExtensionContext, settings: () => ContextCapSettings) => {
    try {
      const request: ContextCapSessionRequest = {};
      pi.events.emit("piop:context-cap:session", request);
      if (!request.session) throw new Error("The context cap extension is not loaded");
      await request.session.updateSettings(settings());
    } catch (error) {
      if (!closed) ctx.ui.notify("Context cap settings could not be applied: " + (error instanceof Error ? error.message : String(error)), "error");
      throw error;
    }
  };
  const stops = [
    pi.events.on("piop:agents:ready", ({ ctx }) => { apply(ctx, load).catch(() => undefined); }),
    pi.events.on("piop:rpc", request => {
      if (request.command !== "context_cap_settings") return;
      request.ready = apply(request.ctx, () => (request.payload as { settings: ContextCapSettings }).settings);
    }),
  ];
  pi.on("session_shutdown", () => { closed = true; for (const stop of stops) stop(); });
}
