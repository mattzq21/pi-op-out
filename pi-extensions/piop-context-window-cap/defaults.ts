import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextCapSettings } from "./interface.ts";
import type { AgentSelectedEvent } from "../piop-define-agents/contracts.ts";

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:ready", handler: (event: AgentSelectedEvent) => void): () => void;
    emit(channel: "piop:agents:ready", event: AgentSelectedEvent): void;
  }
}

// The daemon gives Pi the context cap settings when it starts Pi, and sends each change. Pi applies the latest of them.
function launchSettings(): ContextCapSettings {
  const text = process.env.PIOP_CONTEXT_CAP_SETTINGS;
  if (!text) throw new Error("Invalid context cap settings: the daemon did not give them to Pi");
  return JSON.parse(text);
}

export function registerContextCapSettings(pi: ExtensionAPI, updateSettings: (settings: ContextCapSettings) => Promise<unknown>) {
  let latest: ContextCapSettings | undefined;
  let closed = false;
  const apply = async (ctx: ExtensionContext, settings: () => ContextCapSettings) => {
    try {
      await updateSettings(settings());
    } catch (error) {
      if (!closed) ctx.ui.notify("Context cap settings could not be applied: " + (error instanceof Error ? error.message : String(error)), "error");
      throw error;
    }
  };
  const stops = [
    pi.events.on("piop:agents:ready", ({ ctx }) => { apply(ctx, () => latest ?? launchSettings()).catch(() => undefined); }),
    pi.events.on("piop:rpc", request => {
      if (request.command !== "context_cap_settings") return;
      const settings = (request.payload as { settings: ContextCapSettings }).settings;
      latest = settings;
      request.ready = apply(request.ctx, () => settings);
    }),
  ];
  pi.on("session_shutdown", () => { closed = true; for (const stop of stops) stop(); });
}
