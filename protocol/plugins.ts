import { z } from "zod";

// A plugin is a folder with these files:
// - plugin.json: the manifest below.
// - extension.mjs: the plugin's Pi extension, built into one file. It is needed when the manifest has "extension".
// - client.mjs: the plugin's part of the app, built into one ES module. It is needed when the manifest has "client".
//   It gets "solid-js", "solid-js/web", "solid-js/store", "zod" and "piop/plugin" from the app; see SHARED_MODULES.
//
// piop has its built-in plugins in its build. Other plugins are in ~/.piop/plugins/<id>/. The daemon finds them when it
// starts.

export const PLUGIN_ID = /^[a-z0-9-]+$/;

// How the app shows a custom message of the plugin.
export const pluginMessageSchema = z.strictObject({
  customRole: z.enum(["user", "assistant", "tool", "system", "custom"]).optional(),
  contextInjection: z.boolean().optional(),
  toolName: z.string().optional(),
  toolStatus: z.enum(["running", "done", "error"]).optional(),
  retainContent: z.boolean().optional(),
});
export type PluginMessage = z.output<typeof pluginMessageSchema>;

// How the app shows the plugin's side chats. Their kind is the plugin ID.
export const auxiliaryLookSchema = z.strictObject({
  label: z.string().min(1),
  letter: z.string().min(1).max(2),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type AuxiliaryLook = z.output<typeof auxiliaryLookSchema>;

// Where the client part runs: "host" with the plugin's host, "conversation" only in a chat that has messages, and
// "client" in each conversation of the app, from the local host.
export const pluginScopeSchema = z.enum(["client", "host", "conversation"]);
export type PluginScope = z.output<typeof pluginScopeSchema>;

export const pluginManifestSchema = z.strictObject({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().min(1),
  enabledByDefault: z.boolean().optional(),
  // The Pi extension loads after this core Pi extension.
  extension: z.strictObject({ after: z.enum(["session", "context-bar"]) }).optional(),
  // The slash commands of the plugin. A queued command waits until the current response ends.
  commands: z.record(z.string(), z.enum(["immediate", "queued"])).optional(),
  // The client requests of the plugin, with what each does, for the error when the plugin is off.
  requests: z.record(z.string(), z.string()).optional(),
  agentTools: z.array(z.string()).optional(),
  // The plugin's settings, with their default values. A saved value must have the type of its default.
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // Custom entries that keep only their last value, as the current state of a chat.
  stateRecords: z.array(z.string()).optional(),
  messages: z.record(z.string(), pluginMessageSchema).optional(),
  auxiliary: auxiliaryLookSchema.optional(),
  client: z.strictObject({ scope: pluginScopeSchema }).optional(),
});
export type PluginManifest = z.output<typeof pluginManifestSchema>;

// What clients get about a plugin.
export const pluginSummarySchema = pluginManifestSchema.pick({ id: true, name: true, messages: true, auxiliary: true, client: true });
export type PluginSummary = z.output<typeof pluginSummarySchema>;

export const pluginStatusSchema = z.object({
  enabled: z.array(z.string()), configured: z.array(z.string()), revision: z.string(), error: z.string().nullable(),
  plugins: z.array(pluginSummarySchema), queuedCommands: z.array(z.string()),
});
export type PluginStatus = z.output<typeof pluginStatusSchema>;

// The modules that the app gives to client.mjs, and the global name under which it keeps them.
export const SHARED_MODULES = ["solid-js", "solid-js/web", "solid-js/store", "zod", "piop/plugin"] as const;
export const SHARED_MODULES_KEY = "piop.plugin-modules";
