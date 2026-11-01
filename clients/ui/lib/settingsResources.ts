import { hostCatalog } from "./draftRuntime";
import { reportModels } from "./modelReports";
import type { AgentConfig, Model } from "../types";

export type SettingsResources = { config: AgentConfig; models: Model[] };

export async function settingsResources(hostId: string, fresh = false): Promise<SettingsResources> {
  const { config, models } = await hostCatalog(hostId, fresh ? "fresh" : "cached");
  await reportModels(hostId, models);

  return { config, models };
}

export function preloadSettingsResources() {
  void hostCatalog("local").catch(() => undefined);
}
