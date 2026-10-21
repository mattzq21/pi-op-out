import type { z } from "zod";
import { reviewSettingsSchema } from "./review/settingsSchema";

export const pluginSettingsSchema = reviewSettingsSchema;
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
export const pluginSettingKeys = pluginSettingsSchema.keyof().options;
