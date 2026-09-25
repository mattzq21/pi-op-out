import type { AppSettings } from "../types";

type ClientSettings = Pick<AppSettings, "keybindings" | "hiddenModels" | "knownModels" | "debugMode">;
const storageKey = "piop-client-settings";

function preferences(settings: AppSettings): ClientSettings {
  return { keybindings: settings.keybindings, hiddenModels: settings.hiddenModels, knownModels: settings.knownModels, debugMode: settings.debugMode };
}

function storedPreferences(): Partial<ClientSettings> {
  let stored: Partial<ClientSettings> = {};
  try { stored = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {}; } catch { }
  return stored;
}

export function withClientSettings(settings: AppSettings): AppSettings {
  const stored = storedPreferences();
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
  return { ...settings,
    keybindings: stored.keybindings && typeof stored.keybindings === "object" && Object.values(stored.keybindings).every((item) => typeof item === "string") ? { ...settings.keybindings, ...stored.keybindings } : settings.keybindings,
    hiddenModels: strings(stored.hiddenModels) ? stored.hiddenModels : settings.hiddenModels,
    knownModels: strings(stored.knownModels) ? stored.knownModels : strings(stored.hiddenModels) ? undefined : settings.knownModels,
    debugMode: typeof stored.debugMode === "boolean" ? stored.debugMode : settings.debugMode,
  };
}

export function saveClientSettings(settings: AppSettings) {
  localStorage.setItem(storageKey, JSON.stringify(preferences(settings)));
}

export function preserveDaemonPreferences(settings: AppSettings, daemonSettings: AppSettings): AppSettings {
  return { ...settings, ...preferences(daemonSettings) };
}
