import { defaultPluginSettings, parsePluginSettings } from '../plugins';
import { z } from 'zod';
import { appSettingsSchema, USAGE_INDICATORS, type AppSettings, type RemoteHost, type UsageIndicator } from '../../../protocol/settings';
import { capRangeError } from '../../../pi-extensions/piop-context-window-cap/interface';

export type { AppSettings, RemoteHost, ToolConfig, SkillConfig, UsageIndicator } from '../../../protocol/settings';
export { USAGE_INDICATORS };

export const MAX_REMOTE_HOSTS = 16;

export const isUsageIndicator = (value: unknown): value is UsageIndicator => (USAGE_INDICATORS as readonly unknown[]).includes(value);

export function validateContextCaps(settings: AppSettings): void {
  const error = capRangeError(settings.contextWindowCap, 'General context cap');
  if (error) throw new Error(error);
  for (const [model, cap] of Object.entries(settings.modelContextWindowCaps)) {
    if (!model.includes('/')) throw new Error(`Context cap model "${model}" must be written as provider/model`);
    const capError = cap === null ? undefined : capRangeError(cap, `Context cap for ${model}`);
    if (capError) throw new Error(capError);
  }
}

// Settings from a client or from storage, with the defaults filled in. Each plugin checks its own settings.
export function parseAppSettings(value: unknown): AppSettings {
  const parsed = appSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid settings: ' + z.prettifyError(parsed.error));
  return completeSettings(parsed.data);
}

// Checked settings with each plugin's own settings checked by that plugin, and without the tools: the daemon keeps
// the tools that Pi reported.
export function completeSettings(settings: AppSettings): AppSettings {
  return { ...settings, plugins: parsePluginSettings(settings.plugins), tools: [] };
}

export function serializeAppSettings(settings: AppSettings): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (settings.settingsRevision !== undefined) result.settingsRevision = settings.settingsRevision;
  result.plugins = settings.plugins;
  result.localEnabled = settings.localEnabled;
  result.modelAliases = settings.modelAliases ?? {};
  result.hiddenModels = settings.hiddenModels;
  if (settings.knownModels !== undefined) result.knownModels = settings.knownModels;
  result.defaultThinking = settings.defaultThinking;
  result.defaultFastMode = settings.defaultFastMode;
  result.contextWindowCap = settings.contextWindowCap;
  result.contextWindowCapEnabled = settings.contextWindowCapEnabled;
  result.modelContextWindowCaps = settings.modelContextWindowCaps;
  result.autoRetry = settings.autoRetry;
  result.hiddenUsageIndicators = settings.hiddenUsageIndicators;
  result.debugMode = settings.debugMode;
  result.keybindings = settings.keybindings;
  result.tools = settings.tools;
  result.skills = settings.skills;
  result.hosts = settings.hosts.map(host => ({ enabled: host.enabled, id: host.id, name: host.name, target: host.target, piPath: host.piPath }));
  return result;
}

export function cloneSettings(settings: AppSettings): AppSettings {
  const clone = parseAppSettings(JSON.parse(JSON.stringify(serializeAppSettings(settings))));
  clone.tools = structuredClone(settings.tools);
  return clone;
}

export function defaultSettings(): AppSettings {
  return { ...appSettingsSchema.parse({ defaultThinking: 'medium', skills: [] }), plugins: defaultPluginSettings() };
}


export function validateRemoteHost(host: RemoteHost): void {
  if (!host.target || !/^[A-Za-z0-9._@:\-\[\]]+$/.test(host.target)) throw new Error('SSH target may only contain a host, user, and port-safe characters');
  if (!host.piPath || !/^[A-Za-z0-9._\/\-~]+$/.test(host.piPath)) throw new Error('Pi executable must be a plain executable name or path');
}
