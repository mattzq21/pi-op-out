import { defaultKeybindings, shortcutsConflict } from "../lib/keybindings";
import { plugins } from "./index";
import type { PluginDefinition, PluginKeybind } from "./types";

export type PluginKeybindBinding = PluginKeybind & { action: string; plugin: PluginDefinition };

export const pluginKeybindSections = plugins.flatMap(plugin => plugin.keybinds?.length ? [{ plugin, keybinds: plugin.keybinds.map(keybind => ({ ...keybind, action: `${plugin.id}.${keybind.id}`, plugin })) }] : []);

export const pluginKeybinds: PluginKeybindBinding[] = pluginKeybindSections.flatMap(section => section.keybinds);

export const allDefaultKeybindings = (): Record<string, string> => ({ ...defaultKeybindings, ...Object.fromEntries(pluginKeybinds.map(keybind => [keybind.action, keybind.defaultShortcut])) });

export function withPluginKeybinds(keybindings: Record<string, string>): Record<string, string> {
  const known = new Set([...Object.keys(defaultKeybindings), ...pluginKeybinds.map(keybind => keybind.action)]);
  const result = Object.fromEntries(Object.entries(keybindings).filter(([action]) => known.has(action)));

  for (const keybind of pluginKeybinds) {
    if (keybind.action in result) continue;
    result[keybind.action] = Object.values(result).some(shortcut => shortcutsConflict(shortcut, keybind.defaultShortcut)) ? "" : keybind.defaultShortcut;
  }

  return result;
}
