import { shortcutsConflict } from "../lib/keybindings";
import { pluginStatus } from "./index";
import type { PluginKeybind, PluginSummary } from "../../../protocol/plugins";

// A plugin keybind with the name of its setting: "<plugin ID>.<keybind ID>".
export type PluginKeybindBinding = PluginKeybind & { action: string; plugin: PluginSummary };

// The keybinds of the plugins of a host, by plugin, in the host's plugin order.
export const pluginKeybindSections = (host: string) => (pluginStatus(host)?.plugins ?? []).flatMap(plugin => plugin.keybinds?.length
  ? [{ plugin, keybinds: plugin.keybinds.map(keybind => ({ ...keybind, action: `${plugin.id}.${keybind.id}`, plugin })) }] : []);

export const pluginKeybinds = (host: string): PluginKeybindBinding[] => pluginKeybindSections(host).flatMap(section => section.keybinds);

// The keybindings with a shortcut for each plugin keybind: the user's own, else its default when no other shortcut has it.
export function withPluginKeybinds(keybindings: Record<string, string>, bindings: readonly PluginKeybindBinding[]): Record<string, string> {
  const result = { ...keybindings };

  for (const keybind of bindings) {
    if (Object.hasOwn(result, keybind.action)) continue;
    result[keybind.action] = Object.values(result).some(shortcut => shortcutsConflict(shortcut, keybind.defaultShortcut)) ? "" : keybind.defaultShortcut;
  }

  return result;
}
