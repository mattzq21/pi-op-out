import { z } from "zod";
import type { AppSettings, SettingsChange } from "../types";

export const clientPreferencesSchema = z.object({
  keybindings: z.record(z.string(), z.string()),
  debugMode: z.boolean(),
});

export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

export const clientPreferenceKeys = new Set<keyof AppSettings>(["keybindings", "debugMode"]);

export function clientPreferences(settings: AppSettings): ClientPreferences {
  return { keybindings: { ...settings.keybindings }, debugMode: settings.debugMode };
}

function mergeKeybindings(latest: ClientPreferences["keybindings"], baseline: ClientPreferences["keybindings"], intended: ClientPreferences["keybindings"]) {
  const keybindings = { ...latest };
  const conflicts: string[] = [];

  for (const key of new Set([...Object.keys(baseline), ...Object.keys(intended)])) {
    const before = baseline[key];
    const after = intended[key];

    if (before === after) continue;

    if (latest[key] !== before && latest[key] !== after) conflicts.push(`keybindings.${key}`);

    if (after === undefined) delete keybindings[key];
    else keybindings[key] = after;
  }

  return { keybindings, conflicts };
}

export function mergeClientPreferences(latest: ClientPreferences, baseline: ClientPreferences, intended: ClientPreferences) {
  const { keybindings, conflicts } = mergeKeybindings(latest.keybindings, baseline.keybindings, intended.keybindings);

  const preferences: ClientPreferences = {
    keybindings,
    debugMode: intended.debugMode === baseline.debugMode ? latest.debugMode : intended.debugMode,
  };

  return { preferences, conflicts };
}

export function applyClientPreferences(settings: AppSettings, preferences: ClientPreferences): AppSettings {
  return { ...settings, ...preferences, keybindings: { ...settings.keybindings, ...preferences.keybindings } };
}

export class SettingsSaveError extends Error {
  constructor(message: string, readonly committedChange: SettingsChange, readonly phase: "client" | "reconnect", readonly conflict?: ClientPreferenceConflictError) { super(message); }
}

export class ClientPreferenceConflictError extends Error {
  constructor(message: string, readonly latest?: AppSettings) { super(message); }
}
