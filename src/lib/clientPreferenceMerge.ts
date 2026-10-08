import { z } from "zod";
import type { AppSettings, SettingsChange } from "../types";

export const clientPreferencesSchema = z.object({
  keybindings: z.record(z.string(), z.string()),
  hiddenModels: z.array(z.string()),
  knownModels: z.array(z.string()).optional(),
  debugMode: z.boolean(),
});

export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

export const clientPreferenceKeys = new Set<keyof AppSettings>(["keybindings", "hiddenModels", "knownModels", "debugMode"]);

export function clientPreferences(settings: AppSettings): ClientPreferences {
  return { keybindings: { ...settings.keybindings }, hiddenModels: [...settings.hiddenModels], knownModels: settings.knownModels && [...settings.knownModels], debugMode: settings.debugMode };
}

function mergeMemberships(latest: string[], baseline: string[], intended: string[]) {
  const before = new Set(baseline);
  const after = new Set(intended);
  const merged = new Set(latest.filter(id => !before.has(id) || after.has(id)));

  for (const id of intended) if (!before.has(id)) merged.add(id);

  return [...merged];
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

function mergeKnownModels(latest?: string[], baseline?: string[], intended?: string[]) {
  if (latest === undefined && intended === undefined) return undefined;

  return mergeMemberships(latest ?? [], baseline ?? [], intended ?? []);
}

export function mergeClientPreferences(latest: ClientPreferences, baseline: ClientPreferences, intended: ClientPreferences) {
  const { keybindings, conflicts } = mergeKeybindings(latest.keybindings, baseline.keybindings, intended.keybindings);

  const preferences: ClientPreferences = {
    keybindings,
    hiddenModels: mergeMemberships(latest.hiddenModels, baseline.hiddenModels, intended.hiddenModels),
    knownModels: mergeKnownModels(latest.knownModels, baseline.knownModels, intended.knownModels),
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
