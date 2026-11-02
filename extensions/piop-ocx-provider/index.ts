import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { OCX_PROVIDER_ID, ocxProviderConfig } from "./ocx-provider.mjs";

export default async function ocxProvider(pi: ExtensionAPI) {
  let failure: string | undefined;
  try {
    const config = await ocxProviderConfig(homedir());
    if (config) pi.registerProvider(OCX_PROVIDER_ID, config);
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  if (failure !== undefined) pi.on("session_start", (_event, ctx) => ctx.ui.notify("OCX models are unavailable: " + failure, "warning"));
}
