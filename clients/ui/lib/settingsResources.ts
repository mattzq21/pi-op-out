import { z } from "zod";
import { agentConfigSchema } from "./agentSchemas";
import { reportModels } from "./modelReports";
import { NativeTransport } from "./nativeTransport";
import { listen } from "./platform";
import { modelSchema } from "./responseSchemas";
import type { AgentConfig, Model } from "../types";

/** What the host settings pages need from a running Pi: its models, thinking levels and agent definitions. */
export type SettingsResources = { config: AgentConfig; models: Model[]; levels: string[] };

/**
 * Settings resources per host. Reading them starts a Pi session, so they are read only when the settings are about to open,
 * and kept until the host's settings or provider logins change. A change drops them; the next use reads them again.
 */
const cache = new Map<string, Promise<SettingsResources>>();
let listening = false;
let owners = 0;
let generation = 0;
let subscriptions: Array<Promise<() => void>> = [];

export function retainSettingsResources() {
  owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owners) return;
    generation++;
    cache.clear();
    listening = false;
    for (const pending of subscriptions) void pending.then(unlisten => unlisten(), () => undefined);
    subscriptions = [];
  };
}

async function load(hostId: string): Promise<SettingsResources> {
  const reader = new NativeTransport({ hostId, cwd: "~" });

  try {
    await reader.connect();
    const [models, levels, config] = await Promise.all([
      reader.command({ type: "get_available_models" }, z.object({ models: z.array(modelSchema) })),
      reader.command({ type: "get_available_thinking_levels" }, z.object({ levels: z.array(z.string()) })),
      reader.command({ type: "get_agent_configuration" }, agentConfigSchema),
    ]);
    await reportModels(hostId, models.models);
    return { config, models: models.models, levels: levels.levels };
  } finally { await reader.dispose().catch(reason => console.error("Could not close the settings reader:", reason)); }
}

function start(hostId: string): Promise<SettingsResources> {
  const loading = load(hostId);
  cache.set(hostId, loading);
  // A failed load is not kept: the next request tries again and shows its own error.
  loading.catch(() => { if (cache.get(hostId) === loading) cache.delete(hostId); });
  return loading;
}

function changed(hostId: string) {
  cache.delete(hostId);
}

function listenForChanges() {
  if (listening) return;
  listening = true;
  const current = generation;
  const receive = (hostId: string) => { if (current === generation) changed(hostId); };
  subscriptions = [
    listen("pi://provider-auth-changed", ({ payload }) => receive(payload.hostId), z.object({ hostId: z.string() })),
    listen("pi://settings-changed", () => receive("local"), z.unknown()),
    listen("pi://host-settings-changed", ({ payload }) => receive(payload.hostId), z.object({ hostId: z.string() }).loose()),
  ];
  for (const pending of subscriptions) void pending.catch(reason => console.error("Could not listen for settings resource changes:", reason));
}

/** The host's settings resources, from the cache when they are still current. */
export function settingsResources(hostId: string): Promise<SettingsResources> {
  listenForChanges();
  return cache.get(hostId) ?? start(hostId);
}

/** Loads the host's settings resources again, for example after the settings page saw a change. */
export function reloadSettingsResources(hostId: string): Promise<SettingsResources> {
  listenForChanges();
  return start(hostId);
}

/** Loads the local host's settings resources when the user is about to open the settings, so the page opens without waiting for Pi. Errors show when the page opens. */
export function preloadSettingsResources() {
  void settingsResources("local").catch(() => undefined);
}
