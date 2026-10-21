import { z } from "zod";

export type ClientPreferenceMerge<T> = (latest: T, baseline: T, intended: T, conflicts: string[]) => T;

export interface ClientPreferenceSection<S extends z.ZodObject> {
  schema: S;
  merge?: { [K in keyof z.infer<S>]?: ClientPreferenceMerge<z.infer<S>[K]> };
  copy?: { [K in keyof z.infer<S>]?: (value: z.infer<S>[K]) => z.infer<S>[K] };
}

export const pluginClientPreferencesSchema = z.object({});
export type PluginClientPreferences = Record<never, unknown>;
type Key = keyof PluginClientPreferences;
export const pluginClientPreferenceKeys = Object.keys(pluginClientPreferencesSchema.shape) as Key[];

const fieldMerges: { [K in Key]?: ClientPreferenceMerge<PluginClientPreferences[K]> } = {};
const fieldCopies: { [K in Key]?: (value: PluginClientPreferences[K]) => PluginClientPreferences[K] } = {};

function build(value: <K extends Key>(key: K) => PluginClientPreferences[K]): PluginClientPreferences {
  const result: Partial<PluginClientPreferences> = {};
  const set = <K extends Key>(key: K) => { result[key] = value(key); };

  pluginClientPreferenceKeys.forEach(set);
  return result as PluginClientPreferences;
}

export function pluginClientPreferences(settings: PluginClientPreferences): PluginClientPreferences {
  return build(<K extends Key>(key: K) => {
    const copy = fieldCopies[key];
    return copy ? copy(settings[key]) : settings[key];
  });
}

function mergeField<K extends Key>(key: K, latest: PluginClientPreferences, baseline: PluginClientPreferences, intended: PluginClientPreferences, conflicts: string[]): PluginClientPreferences[K] {
  const merge = fieldMerges[key];

  if (merge) return merge(latest[key], baseline[key], intended[key], conflicts);

  return JSON.stringify(intended[key]) === JSON.stringify(baseline[key]) ? latest[key] : intended[key];
}

export function mergePluginClientPreferences(latest: PluginClientPreferences, baseline: PluginClientPreferences, intended: PluginClientPreferences, conflicts: string[]): PluginClientPreferences {
  return build(key => mergeField(key, latest, baseline, intended, conflicts));
}

export function storedPluginClientPreferences(value: unknown): PluginClientPreferences {
  const fields = z.record(z.string(), z.unknown()).catch({}).parse(value);

  return build(<K extends Key>(key: K) => {
    const field = (pluginClientPreferencesSchema.shape as Record<string, z.ZodType>)[key].safeParse(fields[key]);
    return (field.success ? field.data : undefined) as PluginClientPreferences[K];
  });
}
