import { z, type JSONType } from "zod";
import type { AgentConfig, AgentProfile, AppSettings } from "../types";

type SettingsSnapshotValue = AppSettings[keyof AppSettings] | AgentProfile[] | { settings: AppSettings; agentConfig?: AgentConfig };

function sortedJson(value: JSONType): JSONType {
  if (Array.isArray(value)) return value.map(sortedJson);
  const object = z.record(z.string(), z.json()).safeParse(value);

  if (!object.success) return value;

  return Object.fromEntries(Object.entries(object.data).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortedJson(item)]));
}

export function stableSnapshot(value: SettingsSnapshotValue) {
  const serialized = JSON.stringify(value);

  return serialized === undefined ? undefined : JSON.stringify(sortedJson(z.json().parse(JSON.parse(serialized))));
}

export function settingsSnapshot(settings: AppSettings, agentConfig?: AgentConfig) {
  const { settingsRevision: _settingsRevision, clientSettingsRevision: _clientSettingsRevision, settingsDurabilityError: _settingsDurabilityError, clientSettingsDurabilityError: _clientSettingsDurabilityError, ...value } = settings;

  return stableSnapshot({ settings: value, agentConfig: agentConfig && { ...agentConfig, revision: undefined } });
}

export function agentEditsSnapshot(config?: AgentConfig) {
  return stableSnapshot(config?.agents.map(item => item.extensions ? { ...item, extensions: item.extensions.map(path => path.trim()).filter(Boolean) } : item));
}

export const settingKeys: Array<keyof AppSettings> = [
  "dictationEngine", "dictationEnginePath", "dictationModelPath", "dictationLanguage", "dictationModels", "localEnabled", "defaultAgent", "defaultModel", "hiddenModels", "knownModels", "defaultThinking", "defaultFastMode", "contextWindowCap", "contextWindowCapEnabled", "autoRetry", "debugMode", "keybindings", "tools", "skills", "hosts",
];
