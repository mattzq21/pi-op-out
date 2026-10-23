import { lazy } from "solid-js";
import { pluginStatus, plugins } from ".";

export const pluginSettingsSections = plugins.flatMap(plugin => plugin.settings ? [{ ...plugin.settings, plugin: plugin.id, component: lazy(plugin.settings.load) }] : []);

export const pluginSettingsEnabled = (host: string, section: string) => pluginSettingsSections.some(item => item.section === section && pluginStatus(host)?.enabled.includes(item.plugin));
