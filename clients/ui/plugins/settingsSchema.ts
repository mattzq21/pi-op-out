import { z } from "zod";

// Each plugin's own settings, under its plugin ID. Each plugin checks its own values.
export const pluginSettingsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
