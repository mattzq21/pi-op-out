import type { z } from "zod";
import type { dictationConfigurationSchema, dictationEngineSchema, dictationEngineSettingsSchema, dictationFoundEnginesSchema, dictationModelEntrySchema, dictationSettingsSchema } from "./settingsSchema";

export type DictationEngine = z.infer<typeof dictationEngineSchema>;
export type DictationModelEntry = z.infer<typeof dictationModelEntrySchema>;
export type DictationEngineSettings = z.infer<typeof dictationEngineSettingsSchema>;
export type DictationSettings = z.infer<typeof dictationSettingsSchema>;
export type DictationFoundEngines = z.infer<typeof dictationFoundEnginesSchema>;
export type DictationConfiguration = z.infer<typeof dictationConfigurationSchema>;
