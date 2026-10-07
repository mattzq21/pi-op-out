import type { AppSettings } from "../types";
import { invoke } from "./platform";
import { z } from "zod";

type ClientSettings = Pick<AppSettings, "keybindings" | "hiddenModels" | "knownModels" | "debugMode">;

const storageKey = "piop-client-settings";

const clientSettingsSchema = z.object({
  keybindings: z.record(z.string(), z.string()).optional().catch(undefined),
  hiddenModels: z.array(z.string()).optional().catch(undefined),
  knownModels: z.array(z.string()).optional().catch(undefined),
  debugMode: z.boolean().optional().catch(undefined),
}).catch({});

type StoredPreferences = z.infer<typeof clientSettingsSchema>;

export function preferences(settings: AppSettings): ClientSettings {
  return { keybindings: settings.keybindings, hiddenModels: settings.hiddenModels, knownModels: settings.knownModels, debugMode: settings.debugMode };
}

async function storedPreferences(): Promise<{ settings: StoredPreferences; persisted: boolean }> {
  const stored = await invoke("load_client_settings", undefined, clientSettingsSchema.nullable());

  if (stored) return { settings: clientSettingsSchema.parse(stored), persisted: true };

  try { return { settings: clientSettingsSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "null")), persisted: false }; } catch { return { settings: {}, persisted: false }; }
}

export async function withClientSettings(source: AppSettings | Promise<AppSettings>, migrate = false): Promise<AppSettings> {
  const [settings, preferences] = await Promise.all([source, storedPreferences()]);
  const merged = mergeClientSettings(settings, preferences.settings);

  if (migrate && !preferences.persisted) await saveClientSettings(merged);

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

export async function saveClientSettings(settings: AppSettings) {
  await invoke("save_client_settings", { settings: preferences(settings) });

  try { localStorage.removeItem(storageKey); } catch { }
}

export function preserveDaemonPreferences(settings: AppSettings, daemonSettings: AppSettings): AppSettings {
  return { ...settings, ...preferences(daemonSettings) };
}
