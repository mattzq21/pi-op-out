import { cost } from './cost/plugin';
import { review } from './review/plugin';
import type { ReviewSettings } from './review/settings';
import type { BundledPlugin } from './types';

/** Every plugin bundled with the daemon, in display order. A new configuration enables all of them. */
export const CATALOG: readonly BundledPlugin[] = [
  cost,
  review,
];

/** The app settings fields that plugins own. */
export type PluginSettings = ReviewSettings;

export function parsePluginSettings(value: Record<string, unknown>): PluginSettings {
  return Object.assign({}, ...CATALOG.map(plugin => plugin.settings?.parse(value) ?? {}));
}

export function defaultPluginSettings(): PluginSettings {
  return Object.assign({}, ...CATALOG.map(plugin => plugin.settings?.defaults() ?? {}));
}

/** Adds the plugin-owned fields to saved settings, in catalog and field order. */
export function serializePluginSettings(settings: PluginSettings, result: Record<string, unknown>): void {
  for (const plugin of CATALOG) for (const field of plugin.settings?.fields ?? []) result[field] = (settings as any)[field];
}
