import { hostCatalog } from "./draftRuntime";
import { reportModels } from "./modelReports";
import type { AgentConfig, Model } from "../types";

/** What the host settings pages need: the host's models and agent definitions. */
export type SettingsResources = { config: AgentConfig; models: Model[] };

/** The host's settings resources, from its catalog, which the daemon reads without starting Pi. fresh reads them again. */
export async function settingsResources(hostId: string, fresh = false): Promise<SettingsResources> {
  const { config, models } = await hostCatalog(hostId, fresh ? "fresh" : "cached");
  await reportModels(hostId, models);

  return { config, models };
}

/** Loads the local host's settings resources when the user is about to open the settings, so the page opens without waiting. Errors show when the page opens. */
export function preloadSettingsResources() {
  void hostCatalog("local").catch(() => undefined);
}
