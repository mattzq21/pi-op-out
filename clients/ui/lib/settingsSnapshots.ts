import { pluginSettingKeys } from "../plugins/settingsSchema";
import type { AgentConfig, AgentProfile, AppSettings } from "../types";

type SettingsSnapshotValue = AppSettings[keyof AppSettings] | AgentProfile[] | { settings: Omit<AppSettings, "tools">; agentConfig?: AgentConfig };

/** The value with object keys in sorted order. The value comes from JSON.parse, so it holds only JSON values. */
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);

  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;

  return Object.fromEntries(Object.keys(object).sort().map(key => [key, sortedJson(object[key])]));
}

/** JSON text of the value with sorted object keys, so equal settings give equal text whatever their key order. */
export function stableSnapshot(value: SettingsSnapshotValue) {
  const serialized = JSON.stringify(value);

  return serialized === undefined ? undefined : JSON.stringify(sortedJson(JSON.parse(serialized)));
}

export function settingsSnapshot(settings: AppSettings, agentConfig?: AgentConfig) {
  const { settingsRevision: _settingsRevision, clientSettingsRevision: _clientSettingsRevision, settingsDurabilityError: _settingsDurabilityError, clientSettingsDurabilityError: _clientSettingsDurabilityError, tools: _tools, ...value } = settings;

  // Daemon settings carry no debug feature choices; no list means no feature is off.
  return stableSnapshot({ settings: { ...value, debugFeaturesOff: value.debugFeaturesOff ?? [] }, agentConfig: agentConfig && { ...agentConfig, revision: undefined } });
}

export function agentEditsSnapshot(config?: AgentConfig) {
  return stableSnapshot(config?.agents.map(item => item.extensions ? { ...item, extensions: item.extensions.map(path => path.trim()).filter(Boolean) } : item));
}

export const settingKeys: Array<keyof AppSettings> = [
  "localEnabled", ...pluginSettingKeys, "modelAliases", "hiddenModels", "knownModels", "defaultThinking", "defaultFastMode", "contextWindowCap", "contextWindowCapEnabled", "modelContextWindowCaps", "autoRetry", "debugMode", "debugFeaturesOff", "keybindings", "skills", "hosts",
];
