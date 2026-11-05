import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppRequest } from "../../daemon/resources/session-broker/index.ts";

export default function providersRefresh(pi: ExtensionAPI) {
  pi.events.on("piop:rpc", (request: AppRequest) => {
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
