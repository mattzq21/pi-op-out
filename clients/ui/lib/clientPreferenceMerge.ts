import { z } from "zod";
import type { AppSettings, SavedDictationModel, SettingsChange } from "../types";
import { savedDictationModelSchema } from "./responseSchemas";

export const clientPreferencesSchema = z.object({
  keybindings: z.record(z.string(), z.string()),
  hiddenModels: z.array(z.string()),
  knownModels: z.array(z.string()).optional(),
  debugMode: z.boolean(),
  dictationEnginePath: z.string().optional(),
  dictationModelPath: z.string().optional(),
  dictationArgs: z.string().optional(),
  dictationModels: z.array(savedDictationModelSchema).optional(),
});

export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

/** Dictation preferences hold one value each. A save changes one only when this client edited it. */
const dictationKeys = ["dictationEnginePath", "dictationModelPath", "dictationArgs"] as const;

export const clientPreferenceKeys = new Set<keyof AppSettings>(["keybindings", "hiddenModels", "knownModels", "debugMode", "dictationModels", ...dictationKeys]);

export function clientPreferences(settings: AppSettings): ClientPreferences {
  return { keybindings: { ...settings.keybindings }, hiddenModels: [...settings.hiddenModels], knownModels: settings.knownModels && [...settings.knownModels], debugMode: settings.debugMode, dictationEnginePath: settings.dictationEnginePath, dictationModelPath: settings.dictationModelPath, dictationArgs: settings.dictationArgs, dictationModels: settings.dictationModels?.map(model => ({ ...model })) };
}

/** The identity of a saved setup: all three fields. */
export const savedModelKey = (model: SavedDictationModel) => JSON.stringify([model.path, model.program ?? "", model.args ?? ""]);

/** Keeps saved setups from other windows. This client's removals and additions win. */
function mergeSavedModels(latest?: SavedDictationModel[], baseline?: SavedDictationModel[], intended?: SavedDictationModel[]) {
  if (latest === undefined && intended === undefined) return undefined;
  const byKey = new Map([...(latest ?? []), ...(intended ?? [])].map(model => [savedModelKey(model), model]));

  return mergeMemberships((latest ?? []).map(savedModelKey), (baseline ?? []).map(savedModelKey), (intended ?? []).map(savedModelKey)).map(key => byKey.get(key)!);
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
    dictationEnginePath: intended.dictationEnginePath === baseline.dictationEnginePath ? latest.dictationEnginePath : intended.dictationEnginePath,
    dictationModelPath: intended.dictationModelPath === baseline.dictationModelPath ? latest.dictationModelPath : intended.dictationModelPath,
    dictationArgs: intended.dictationArgs === baseline.dictationArgs ? latest.dictationArgs : intended.dictationArgs,
    dictationModels: mergeSavedModels(latest.dictationModels, baseline.dictationModels, intended.dictationModels),
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
