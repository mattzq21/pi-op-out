import { z } from "zod";
import type { AppSettings, DictationEngineSettings, SettingsChange } from "../types";
import { dictationEngineSchema, dictationEngineSettingsSchema } from "./responseSchemas";

export const clientPreferencesSchema = z.object({
  keybindings: z.record(z.string(), z.string()),
  debugMode: z.boolean(),
  dictationEngine: dictationEngineSchema.optional(),
  dictationEngines: z.array(dictationEngineSettingsSchema).optional(),
  dictationModelPath: z.string().optional(),
  dictationArgs: z.string().optional(),
});

export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

/** Dictation preferences hold one value each. A save changes one only when this client edited it. */
const dictationKeys = ["dictationEngine", "dictationModelPath", "dictationArgs"] as const;

export const clientPreferenceKeys = new Set<keyof AppSettings>(["keybindings", "debugMode", "dictationEngines", ...dictationKeys]);

export function clientPreferences(settings: AppSettings): ClientPreferences {
  return { keybindings: { ...settings.keybindings }, debugMode: settings.debugMode, dictationEngine: settings.dictationEngine, dictationModelPath: settings.dictationModelPath, dictationArgs: settings.dictationArgs, dictationEngines: settings.dictationEngines?.map(entry => ({ ...entry, models: entry.models.map(model => ({ ...model })) })) };
}

function mergeEngines(conflicts: string[], latest?: DictationEngineSettings[], baseline?: DictationEngineSettings[], intended?: DictationEngineSettings[]) {
  if (latest === undefined && intended === undefined) return undefined;
  const find = (entries: DictationEngineSettings[] | undefined, engine: string) => entries?.find(entry => entry.engine === engine);
  const engines = [...new Set([...(latest ?? []), ...(intended ?? [])].map(entry => entry.engine))];

  return engines.flatMap(engine => {
    const before = find(baseline, engine);
    const after = find(intended, engine);
    const current = find(latest, engine);
    const changed = JSON.stringify(before) !== JSON.stringify(after);

    if (changed && JSON.stringify(current) !== JSON.stringify(before) && JSON.stringify(current) !== JSON.stringify(after)) conflicts.push(`dictationEngines.${engine}`);
    const chosen = changed ? after : current;
    return chosen ? [chosen] : [];
  });

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
    dictationEngine: intended.dictationEngine === baseline.dictationEngine ? latest.dictationEngine : intended.dictationEngine,
    dictationModelPath: intended.dictationModelPath === baseline.dictationModelPath ? latest.dictationModelPath : intended.dictationModelPath,
    dictationArgs: intended.dictationArgs === baseline.dictationArgs ? latest.dictationArgs : intended.dictationArgs,
    dictationEngines: mergeEngines(conflicts, latest.dictationEngines, baseline.dictationEngines, intended.dictationEngines),
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
