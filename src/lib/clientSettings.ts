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

async function storedPreferences(): Promise<{ settings: StoredPreferences; persisted: boolean; revision: string }> {
  const stored = await invoke("load_client_settings", undefined, z.object({ settings: clientSettingsSchema.nullable(), revision: z.string() }));

  if (stored.settings) return { settings: stored.settings, persisted: true, revision: stored.revision };

  try { return { settings: clientSettingsSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "null")), persisted: false, revision: stored.revision }; } catch { return { settings: {}, persisted: false, revision: stored.revision }; }
}

export async function withClientSettings(source: AppSettings | Promise<AppSettings>, migrate = false): Promise<AppSettings> {
  const [settings, preferences] = await Promise.all([source, storedPreferences()]);
  const merged = { ...mergeClientSettings(settings, preferences.settings), clientSettingsRevision: preferences.revision };

  if (migrate && !preferences.persisted) {
    try { return await saveClientSettings(merged); }
    catch (reason) {
      const latest = await storedPreferences();

      if (!latest.persisted) throw reason;

      return { ...mergeClientSettings(settings, latest.settings), clientSettingsRevision: latest.revision };
    }
  }

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

export async function saveClientSettings(settings: AppSettings, expectedRevision = settings.clientSettingsRevision): Promise<AppSettings> {
  if (!expectedRevision) throw new Error("Reload settings before saving client preferences.");
  const saved = await invoke("save_client_settings", { settings: preferences(settings), expectedRevision }, z.object({ revision: z.string() }));

  try { localStorage.removeItem(storageKey); } catch { }

  return { ...settings, clientSettingsRevision: saved.revision };
}

export function preserveDaemonPreferences(settings: AppSettings, daemonSettings: AppSettings): AppSettings {
  return { ...settings, ...preferences(daemonSettings) };
}
