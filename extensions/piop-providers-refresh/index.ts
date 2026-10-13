import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface AppRequest { command: string; payload: unknown; ctx: ExtensionCommandContext; ready?: Promise<unknown> }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:rpc", handler: (request: AppRequest) => void): () => void;
    emit(channel: "piop:rpc", request: AppRequest): void;
  }
}

export default function providersRefresh(pi: ExtensionAPI) {
  pi.events.on("piop:rpc", request => {
    if (request.command !== "provider_auth_refresh") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      try {
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        pi.events.emit("piop:models-refreshed", { ctx });
      } catch (error) {
        throw new Error(`Could not refresh provider models: ${error instanceof Error ? error.message : String(error)}. Reopen the conversation to retry.`, { cause: error });
      }
    })();
  });
}
