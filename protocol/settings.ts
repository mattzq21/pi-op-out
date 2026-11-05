import { z } from "zod";

// The settings of a host, as clients and the daemon send them. The daemon fills in the defaults when it reads them.

export const USAGE_INDICATORS = ["codex", "anthropic", "opencodeGo", "opencodex"] as const;
export type UsageIndicator = typeof USAGE_INDICATORS[number];

// The app's keyboard shortcuts: each action with its default shortcut.
export const DEFAULT_KEYBINDINGS = {
  newConversation: "Ctrl+N",
  toggleConversations: "Ctrl+B",
  toggleTerminal: "Ctrl+J",
  toggleDebugMode: "Ctrl+D",
  focusComposer: "Ctrl+E",
  openSettings: "Ctrl+,",
  toggleQueueHold: "Ctrl+H",
} as const;
export type KeybindingAction = keyof typeof DEFAULT_KEYBINDINGS;
export type Keybindings = Record<KeybindingAction, string>;

// Each plugin's own settings, under its plugin ID. Each plugin checks its own values.
export const pluginSettingsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;

export const toolConfigSchema = z.object({ name: z.string(), description: z.string(), source: z.string() });
export type ToolConfig = z.infer<typeof toolConfigSchema>;

export const skillConfigSchema = z.object({ name: z.string(), path: z.string(), description: z.string(), enabled: z.boolean(), userInvokedOnly: z.boolean().optional() });
export type SkillConfig = z.infer<typeof skillConfigSchema>;

export const remoteHostSchema = z.object({ enabled: z.boolean().default(true), id: z.string(), name: z.string(), target: z.string(), piPath: z.string().default("pi") });
export type RemoteHost = z.infer<typeof remoteHostSchema>;

// Shortcuts of actions that do not exist are dropped, and each action without a shortcut gets its default.
const keybindingsSchema = z.record(z.string(), z.string()).optional().transform((value): Keybindings => {
  const result = { ...DEFAULT_KEYBINDINGS } as Keybindings;
  for (const action of Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[]) if (value?.[action] !== undefined) result[action] = value[action];
  return result;
});

export const appSettingsSchema = z.object({
  settingsRevision: z.string().optional(),
  plugins: pluginSettingsSchema.default({}),
  localEnabled: z.boolean().default(true),
  modelAliases: z.record(z.string(), z.string()).default({})
    .transform(aliases => Object.fromEntries(Object.entries(aliases).flatMap(([id, alias]) => alias.trim() ? [[id, alias.trim()]] : []))),
  hiddenModels: z.array(z.string()).default([]),
  knownModels: z.array(z.string()).nullish().transform(models => models ?? undefined),
  defaultThinking: z.string(),
  defaultFastMode: z.boolean().default(false),
  contextWindowCap: z.number().int().nonnegative().default(300_000),
  contextWindowCapEnabled: z.boolean().default(true),
  modelContextWindowCaps: z.record(z.string(), z.number().int().nullable()).default({}),
  autoRetry: z.boolean().default(true),
  hiddenUsageIndicators: z.array(z.enum(USAGE_INDICATORS)).default([]).transform(indicators => [...new Set(indicators)]),
  debugMode: z.boolean().default(false),
  keybindings: keybindingsSchema,
  tools: z.array(toolConfigSchema).default([]),
  skills: z.array(skillConfigSchema),
  hosts: z.array(remoteHostSchema).default([]),
});
export type AppSettings = z.output<typeof appSettingsSchema>;

export const settingsPublicationSchema = z.object({ committed: z.literal(true), durable: z.boolean(), error: z.string().optional() });

// A saved or current version of the settings, with what clients need to order the versions they see.
export const settingsChangeSchema = z.object({
  settings: appSettingsSchema, publication: settingsPublicationSchema.optional(), committed: z.boolean().optional(), warnings: z.array(z.string()).optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), committedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  synchronizationPending: z.boolean().optional(), source: z.string().optional(), phaseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
