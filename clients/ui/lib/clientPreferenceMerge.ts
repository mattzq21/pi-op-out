import { z } from "zod";
import type { AppSettings, DictationEngineSettings, SettingsChange } from "../types";
import { dictationEngineSchema, dictationEngineSettingsSchema } from "./responseSchemas";

export const clientPreferencesSchema = z.object({
  keybindings: z.record(z.string(), z.string()),
  hiddenModels: z.array(z.string()),
  knownModels: z.array(z.string()).optional(),
  debugMode: z.boolean(),
  dictationEngine: dictationEngineSchema.optional(),
  dictationEngines: z.array(dictationEngineSettingsSchema).optional(),
  dictationModelPath: z.string().optional(),
  dictationArgs: z.string().optional(),
});

export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

/** Dictation preferences hold one value each. A save changes one only when this client edited it. */
const dictationKeys = ["dictationEngine", "dictationModelPath", "dictationArgs"] as const;

export const clientPreferenceKeys = new Set<keyof AppSettings>(["keybindings", "hiddenModels", "knownModels", "debugMode", "dictationEngines", ...dictationKeys]);

export function clientPreferences(settings: AppSettings): ClientPreferences {
  return { keybindings: { ...settings.keybindings }, hiddenModels: [...settings.hiddenModels], knownModels: settings.knownModels && [...settings.knownModels], debugMode: settings.debugMode, dictationEngine: settings.dictationEngine, dictationModelPath: settings.dictationModelPath, dictationArgs: settings.dictationArgs, dictationEngines: settings.dictationEngines?.map(entry => ({ ...entry, models: entry.models.map(model => ({ ...model })) })) };
}

/** Merges the engines by engine type. An engine that this client changed takes this client's value. */
function mergeEngines(latest?: DictationEngineSettings[], baseline?: DictationEngineSettings[], intended?: DictationEngineSettings[]) {
  if (latest === undefined && intended === undefined) return undefined;
  const find = (entries: DictationEngineSettings[] | undefined, engine: string) => entries?.find(entry => entry.engine === engine);
  const engines = [...new Set([...(latest ?? []), ...(intended ?? [])].map(entry => entry.engine))];

  return engines.flatMap(engine => {
    const before = find(baseline, engine);
    const after = find(intended, engine);
    const chosen = JSON.stringify(before) === JSON.stringify(after) ? find(latest, engine) : after;
    return chosen ? [chosen] : [];
  });
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
    dictationEngine: intended.dictationEngine === baseline.dictationEngine ? latest.dictationEngine : intended.dictationEngine,
    dictationModelPath: intended.dictationModelPath === baseline.dictationModelPath ? latest.dictationModelPath : intended.dictationModelPath,
    dictationArgs: intended.dictationArgs === baseline.dictationArgs ? latest.dictationArgs : intended.dictationArgs,
    dictationEngines: mergeEngines(latest.dictationEngines, baseline.dictationEngines, intended.dictationEngines),
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
