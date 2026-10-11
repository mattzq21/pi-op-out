import { z } from "zod";
import type { AppSettings, SavedDictationModel, SettingsChange } from "../types";
import { savedDictationModelSchema } from "./responseSchemas";

export const clientPreferencesSchema = z.object({
  keybindings: z.record(z.string(), z.string()),
  hiddenModels: z.array(z.string()),
  knownModels: z.array(z.string()).optional(),
  debugMode: z.boolean(),
  dictationEngine: z.enum(["transcribe.cpp", "needle"]).optional(),
  dictationEnginePath: z.string().optional(),
  dictationModelPath: z.string().optional(),
  dictationLanguage: z.string().optional(),
  dictationModels: z.array(savedDictationModelSchema).optional(),
});

export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

/** Dictation preferences hold one value each. A save changes one only when this client edited it. */
const dictationKeys = ["dictationEngine", "dictationEnginePath", "dictationModelPath", "dictationLanguage"] as const;

export const clientPreferenceKeys = new Set<keyof AppSettings>(["keybindings", "hiddenModels", "knownModels", "debugMode", "dictationModels", ...dictationKeys]);

export function clientPreferences(settings: AppSettings): ClientPreferences {
  return { keybindings: { ...settings.keybindings }, hiddenModels: [...settings.hiddenModels], knownModels: settings.knownModels && [...settings.knownModels], debugMode: settings.debugMode, dictationEngine: settings.dictationEngine, dictationEnginePath: settings.dictationEnginePath, dictationModelPath: settings.dictationModelPath, dictationLanguage: settings.dictationLanguage, dictationModels: settings.dictationModels?.map(model => ({ ...model })) };
}

function sameSavedModel(left?: SavedDictationModel, right?: SavedDictationModel) {
  return left?.engine === right?.engine && left?.path === right?.path && left?.language === right?.language;
}

/** Keeps saved models from other windows. This client's removals, additions and changes win for the paths it edited. */
function mergeSavedModels(latest?: SavedDictationModel[], baseline?: SavedDictationModel[], intended?: SavedDictationModel[]) {
  if (latest === undefined && intended === undefined) return undefined;
  const before = new Map((baseline ?? []).map(model => [model.path, model]));
  const after = new Map((intended ?? []).map(model => [model.path, model]));
  const merged = (latest ?? []).filter(model => !before.has(model.path) || after.has(model.path));

  for (const model of intended ?? []) {
    if (sameSavedModel(before.get(model.path), model)) continue;
    const index = merged.findIndex(item => item.path === model.path);
    if (index < 0) merged.push(model);
    else merged[index] = model;
  }

  return merged;
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
    dictationEnginePath: intended.dictationEnginePath === baseline.dictationEnginePath ? latest.dictationEnginePath : intended.dictationEnginePath,
    dictationModelPath: intended.dictationModelPath === baseline.dictationModelPath ? latest.dictationModelPath : intended.dictationModelPath,
    dictationLanguage: intended.dictationLanguage === baseline.dictationLanguage ? latest.dictationLanguage : intended.dictationLanguage,
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
