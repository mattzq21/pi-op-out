import { z } from "zod";
import type { ClientPreferenceSection } from "../clientPreferences";
import type { DictationEngineSettings } from "./types";

/** The speech-to-text program the daemon runs: transcribe.cpp or Cactus Needle. */
export const dictationEngineSchema = z.enum(["transcribe.cpp", "needle"]);
/** A saved dictation setup: the model file, the engine program ("" finds it automatically) and the arguments. All three identify it. */
export const dictationModelEntrySchema = z.object({ name: z.string().optional(), path: z.string(), args: z.string().optional() });
export const dictationEngineSettingsSchema = z.object({ engine: dictationEngineSchema, path: z.string().optional(), models: z.array(dictationModelEntrySchema) });
export const dictationSettingsSchema = z.object({ dictationEngine: dictationEngineSchema.optional(), dictationEngines: z.array(dictationEngineSettingsSchema).optional(), dictationModelPath: z.string().optional(), dictationArgs: z.string().optional() });
export const dictationFoundEnginesSchema = z.record(dictationEngineSchema, z.object({ executable: z.string().optional(), error: z.string().optional() }));
export const dictationConfigurationSchema = z.object({ enabled: z.boolean(), loading: z.boolean(), engine: dictationEngineSchema.optional(), executable: z.string().optional(), language: z.string().optional(), languages: z.array(z.string()).optional(), detectLanguage: z.boolean().optional(), error: z.string().optional() });

function mergeEngines(latest: DictationEngineSettings[] | undefined, baseline: DictationEngineSettings[] | undefined, intended: DictationEngineSettings[] | undefined, conflicts: string[]) {
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

export const dictationClientPreferences: ClientPreferenceSection<typeof dictationSettingsSchema> = {
  schema: dictationSettingsSchema,
  merge: { dictationEngines: mergeEngines },
  copy: { dictationEngines: engines => engines?.map(entry => ({ ...entry, models: entry.models.map(model => ({ ...model })) })) },
};
