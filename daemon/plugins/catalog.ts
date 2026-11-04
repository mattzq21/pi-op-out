import { cost } from './cost/plugin';
import { review } from './review/plugin';
import { webSearch } from './web-search/plugin';
import { btw } from './btw/plugin';
import { backgroundCompaction } from './background-compaction/plugin';
import type { BundledPlugin } from './types';

export const CATALOG: readonly BundledPlugin[] = [
  cost,
  review,
  webSearch,
  btw,
  backgroundCompaction,
];

// Each plugin's own settings, under its plugin ID. The core does not know what they contain.
export type PluginSettings = Record<string, Record<string, unknown>>;

function isMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parsePluginSettings(value: unknown): PluginSettings {
  if (value === undefined) return defaultPluginSettings();
  if (!isMap(value)) throw new Error('invalid type for plugins: expected a map');
  const result: PluginSettings = {};
  for (const plugin of CATALOG) {
    if (!plugin.settings) continue;
    const own = value[plugin.id] ?? {};
    if (!isMap(own)) throw new Error(`invalid type for plugins.${plugin.id}: expected a map`);
    result[plugin.id] = plugin.settings.parse(own);
  }
  return result;
}

export function defaultPluginSettings(): PluginSettings {
  return Object.fromEntries(CATALOG.flatMap(plugin => plugin.settings ? [[plugin.id, plugin.settings.defaults()]] : []));
}
