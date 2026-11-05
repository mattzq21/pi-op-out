import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import builtIn from 'piop-builtin-plugins';
import { PLUGIN_ID, pluginManifestSchema, type PluginManifest } from '../../protocol/plugins';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { errorText } from './util/sync';

// A plugin that this daemon found: its manifest and the files that the manifest needs.
export interface Plugin {
  manifest: PluginManifest;
  // The Pi extension, built into one file.
  extension?: string;
  // The client part, built into one ES module.
  client?: string;
}

export interface Catalog {
  // By name.
  plugins: Plugin[];
  // The plugins that could not load.
  errors: string[];
}

// The folder of the plugins that the user installs: one folder for each plugin, named as its ID.
export function pluginDirectory(): string {
  return join(homeDir(), STORAGE_DIRECTORY, 'plugins');
}

function manifest(text: string): PluginManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error('plugin.json is not valid JSON: ' + errorText(error)); }
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid plugin.json: ' + z.prettifyError(parsed.error));
  for (const keybind of parsed.data.keybinds ?? []) if (!Object.hasOwn(parsed.data.commands ?? {}, keybind.command)) throw new Error(`Invalid plugin.json: the keybind ${keybind.id} runs /${keybind.command}, which is not a command of the plugin`);
  return parsed.data;
}

function withFiles(plugin: Plugin): Plugin {
  if (plugin.manifest.extension && plugin.extension === undefined) throw new Error('The manifest has an extension, but extension.mjs is missing');
  if (plugin.manifest.client && plugin.client === undefined) throw new Error('The manifest has a client part, but client.mjs is missing');
  return {
    manifest: plugin.manifest,
    ...plugin.manifest.extension ? { extension: plugin.extension } : {},
    ...plugin.manifest.client ? { client: plugin.client } : {},
  };
}

function optionalFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function installed(folder: string, id: string): Plugin {
  if (!PLUGIN_ID.test(id)) throw new Error('A plugin folder name must have only lowercase letters, digits and hyphens');
  const text = optionalFile(join(folder, 'plugin.json'));
  if (text === undefined) throw new Error('plugin.json is missing');
  const found = manifest(text);
  if (found.id !== id) throw new Error(`The plugin ID ${found.id} is not the folder name`);
  return withFiles({ manifest: found, extension: optionalFile(join(folder, 'extension.mjs')), client: optionalFile(join(folder, 'client.mjs')) });
}

function load(): Catalog {
  const plugins = builtIn.map(item => withFiles({ manifest: manifest(item.manifest), extension: item.extension, client: item.client }));
  const errors: string[] = [];
  const root = pluginDirectory();
  let names: string[] = [];
  try { names = readdirSync(root).sort(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push('Could not read the plugin folder ' + root + ': ' + errorText(error));
  }
  for (const name of names) {
    const folder = join(root, name);
    try {
      if (!statSync(folder).isDirectory()) continue;
      const plugin = installed(folder, name);
      if (plugins.some(item => item.manifest.id === plugin.manifest.id)) throw new Error('piop has a built-in plugin with this ID');
      plugins.push(plugin);
    } catch (error) {
      errors.push(`The plugin in ${folder} could not load: ${errorText(error)}`);
    }
  }
  plugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name) || left.manifest.id.localeCompare(right.manifest.id));
  return { plugins, errors };
}

let loaded: Catalog | undefined;

// The plugins of this daemon. The daemon finds them once; it finds new plugins when it starts again.
export function catalog(): Catalog {
  return loaded ??= load();
}
