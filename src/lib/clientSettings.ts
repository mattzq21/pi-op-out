import type { AppSettings } from "../types";
import { invoke } from "./platform";
import { z } from "zod";
import { applyClientPreferences, clientPreferences, clientPreferencesSchema, ClientPreferenceConflictError } from "./clientPreferenceMerge";

const storageKey = "piop-client-settings";

const clientSettingsSchema = z.object({
  keybindings: z.record(z.string(), z.string()).optional().catch(undefined),
  hiddenModels: z.array(z.string()).optional().catch(undefined),
  knownModels: z.array(z.string()).optional().catch(undefined),
  debugMode: z.boolean().optional().catch(undefined),
}).catch({});

type StoredPreferences = z.infer<typeof clientSettingsSchema>;

async function storedPreferences(): Promise<{ settings: StoredPreferences; persisted: boolean }> {
  const stored = await invoke("load_client_settings", undefined, clientSettingsSchema.nullable());

  if (stored) return { settings: clientSettingsSchema.parse(stored), persisted: true };

  try { return { settings: clientSettingsSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "null")), persisted: false }; } catch { return { settings: {}, persisted: false }; }
}

export async function withClientSettings(source: AppSettings | Promise<AppSettings>, migrate = false): Promise<AppSettings> {
  const [settings, preferences] = await Promise.all([source, storedPreferences()]);
  const merged = mergeClientSettings(settings, preferences.settings);

  if (migrate && !preferences.persisted) return saveClientSettings(merged, settings, true);

  return merged;
}

function mergeClientSettings(settings: AppSettings, stored: StoredPreferences): AppSettings {
  return { ...settings,
    keybindings: stored.keybindings ? { ...settings.keybindings, ...stored.keybindings } : settings.keybindings,
    hiddenModels: stored.hiddenModels ?? settings.hiddenModels,
    knownModels: stored.knownModels ?? (stored.hiddenModels ? undefined : settings.knownModels),
    debugMode: stored.debugMode ?? settings.debugMode,
  };
}

export async function saveClientSettings(settings: AppSettings, baseline: AppSettings, initialize = false): Promise<AppSettings> {
  let stored;

  try { stored = await invoke("save_client_settings", { settings: clientPreferences(settings), baseline: clientPreferences(baseline), initialize }, clientPreferencesSchema); }
  catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);

    if (!message.includes("Client preference conflict at ")) throw reason;
    let latest: AppSettings | undefined;

    try { latest = await withClientSettings(baseline); } catch { }

    throw new ClientPreferenceConflictError(message, latest);
  }

  try { localStorage.removeItem(storageKey); } catch { }

  return applyClientPreferences(settings, stored);
}

export function preserveDaemonPreferences(settings: AppSettings, daemonSettings: AppSettings): AppSettings {
  return { ...settings, ...clientPreferences(daemonSettings), keybindings: { ...daemonSettings.keybindings } };
}
