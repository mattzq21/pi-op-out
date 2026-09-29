import type { AppSettings } from "../types";
import { invoke } from "./platform";

type ClientSettings = Pick<AppSettings, "keybindings" | "hiddenModels" | "knownModels" | "debugMode">;
const storageKey = "piop-client-settings";

function preferences(settings: AppSettings): ClientSettings {
  return { keybindings: settings.keybindings, hiddenModels: settings.hiddenModels, knownModels: settings.knownModels, debugMode: settings.debugMode };
}

async function storedPreferences(): Promise<{ settings: Partial<ClientSettings>; persisted: boolean }> {
  const stored = await invoke<ClientSettings | null>("load_client_settings");
  if (stored) return { settings: stored, persisted: true };
  try { return { settings: JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {}, persisted: false }; } catch { return { settings: {}, persisted: false }; }
}

export async function withClientSettings(source: AppSettings | Promise<AppSettings>, migrate = false): Promise<AppSettings> {
  const [settings, preferences] = await Promise.all([source, storedPreferences()]);
  const merged = mergeClientSettings(settings, preferences.settings);
  if (migrate && !preferences.persisted) await saveClientSettings(merged);
  return merged;
}

function mergeClientSettings(settings: AppSettings, stored: Partial<ClientSettings>): AppSettings {
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
  return { ...settings,
    keybindings: stored.keybindings && typeof stored.keybindings === "object" && Object.values(stored.keybindings).every((item) => typeof item === "string") ? { ...settings.keybindings, ...stored.keybindings } : settings.keybindings,
    hiddenModels: strings(stored.hiddenModels) ? stored.hiddenModels : settings.hiddenModels,
    knownModels: strings(stored.knownModels) ? stored.knownModels : strings(stored.hiddenModels) ? undefined : settings.knownModels,
    debugMode: typeof stored.debugMode === "boolean" ? stored.debugMode : settings.debugMode,
  };
}

export async function saveClientSettings(settings: AppSettings) {
  await invoke("save_client_settings", { settings: preferences(settings) });
  try { localStorage.removeItem(storageKey); } catch { }
}

export function preserveDaemonPreferences(settings: AppSettings, daemonSettings: AppSettings): AppSettings {
  return { ...settings, ...preferences(daemonSettings) };
}
