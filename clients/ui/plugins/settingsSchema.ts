import type { z } from "zod";
import { reviewSettingsSchema } from "./review/settingsSchema";
import { webSearchSettingsSchema } from "./web-search/settingsSchema";

export const pluginSettingsSchema = reviewSettingsSchema.extend(webSearchSettingsSchema.shape);
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
export const pluginSettingKeys = pluginSettingsSchema.keyof().options;
