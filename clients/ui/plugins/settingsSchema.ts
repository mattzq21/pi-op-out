import type { z } from "zod";
import { reviewSettingsSchema } from "./review/settingsSchema";
import { pluginClientPreferencesSchema } from "./clientPreferences";

export const pluginSettingsSchema = reviewSettingsSchema.extend(pluginClientPreferencesSchema.shape);
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
export const pluginSettingKeys = pluginSettingsSchema.keyof().options;
