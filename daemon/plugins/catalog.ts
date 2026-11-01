import { cost } from './cost/plugin';
import { review } from './review/plugin';
import { webSearch } from './web-search/plugin';
import { btw } from './btw/plugin';
import type { ReviewSettings } from './review/settings';
import type { WebSearchSettings } from './web-search/settings';
import type { BundledPlugin } from './types';

export const CATALOG: readonly BundledPlugin[] = [
  cost,
  review,
  webSearch,
  btw,
];

export type PluginSettings = ReviewSettings & WebSearchSettings;

export function parsePluginSettings(value: Record<string, unknown>): PluginSettings {
  return Object.assign({}, ...CATALOG.map(plugin => plugin.settings?.parse(value) ?? {}));
}

export function defaultPluginSettings(): PluginSettings {
  return Object.assign({}, ...CATALOG.map(plugin => plugin.settings?.defaults() ?? {}));
}

export function serializePluginSettings(settings: PluginSettings, result: Record<string, unknown>): void {
  for (const plugin of CATALOG) for (const field of plugin.settings?.fields ?? []) result[field] = (settings as any)[field];
}
