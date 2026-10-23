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
 * Settings resources per host. Reading them starts a Pi session, so they are kept until the host's settings or
 * provider logins change. The local host's resources are loaded again in the background after such a change.
 */
const cache = new Map<string, Promise<SettingsResources>>();
let listening = false;
let owners = 0;
let generation = 0;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let subscriptions: Array<Promise<() => void>> = [];

export function retainSettingsResources() {
  owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owners) return;
    generation++;
    clearTimeout(reloadTimer);
    reloadTimer = undefined;
    cache.clear();
    listening = false;
    for (const pending of subscriptions) void pending.then(unlisten => unlisten(), () => undefined);
    subscriptions = [];
  };
}
const RELOAD_DELAY_MS = 2000;

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

  // Loaded again shortly after, so the next opening of the settings does not wait for Pi.
  if (hostId === "local" && owners && reloadTimer === undefined) reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
    if (owners && !cache.has("local")) void start("local").catch(() => undefined);
  }, RELOAD_DELAY_MS);
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

/** Loads the local host's settings resources in the background, so the settings page opens without waiting for Pi. Errors show when the page opens. */
export function preloadSettingsResources() {
  void settingsResources("local").catch(() => undefined);
}
