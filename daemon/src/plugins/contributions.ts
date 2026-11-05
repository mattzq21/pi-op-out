import type { PluginManifest } from '../../../protocol/plugins';
import { catalog, type Plugin } from './catalog';

export type CoreExtension = NonNullable<PluginManifest['extension']>['after'];

// Each plugin's own settings, under its plugin ID. The core does not know what they contain.
export type PluginSettings = Record<string, Record<string, unknown>>;

let active: ReadonlySet<string> | null = null;

export function activate(ids: readonly string[]): void { active = new Set(ids); }

function loaded(): ReadonlySet<string> {
  if (active === null) throw new Error('Plugins have not started');
  return active;
}

const manifests = (): PluginManifest[] => catalog().plugins.map(plugin => plugin.manifest);

export function find(id: string): Plugin | undefined {
  return catalog().plugins.find(plugin => plugin.manifest.id === id);
}

// The enabled plugins, in the loading order that the user chose.
export function enabled(): Plugin[] {
  return [...loaded()].flatMap(id => find(id) ?? []);
}

export function agentTools(): string[] {
  return [...new Set(enabled().flatMap(plugin => plugin.manifest.agentTools ?? []))];
}

export function commandName(message: string): string | undefined {
  return /^\/(\S+)/.exec(message)?.[1];
}

function commandOwner(name: string): PluginManifest | undefined {
  return manifests().find(plugin => plugin.commands && Object.hasOwn(plugin.commands, name));
}

const CORE_QUEUED = ['compact'];

function disabledCommand(plugin: PluginManifest, name: string): string {
  return 'The ' + plugin.name + ' plugin is disabled. Enable it to use /' + name + '.';
}

export function assertCommandAvailable(message: string): void {
  const name = commandName(message);
  const owner = name === undefined ? undefined : commandOwner(name);
  if (owner && !loaded().has(owner.id)) throw new Error(disabledCommand(owner, name!));
}

export function queuedCommand(message: string): boolean {
  const name = commandName(message);
  if (name !== undefined && CORE_QUEUED.includes(name)) return true;
  const owner = name === undefined ? undefined : commandOwner(name);
  const delivery = owner !== undefined && loaded().has(owner.id) ? owner.commands![name!] : undefined;
  return delivery === 'queued' || (delivery === 'queuedWithPrompt' && hasPrompt(message));
}

function hasPrompt(message: string): boolean {
  return /^\/\S+\s+\S/.test(message.trimStart());
}

export function pluginRequest(type: string): boolean {
  const owner = manifests().find(plugin => plugin.requests && Object.hasOwn(plugin.requests, type));
  if (!owner) return false;
  if (!loaded().has(owner.id)) throw new Error('The ' + owner.name + ' plugin is disabled. Enable it to ' + owner.requests![type] + '.');
  return true;
}

export function commandPolicy(): { queued: string[]; queuedWithPrompt: string[]; withImages: string[]; disabled: Record<string, string> } {
  const ids = loaded();
  const queued: string[] = [...CORE_QUEUED];
  const queuedWithPrompt: string[] = [];
  const withImages: string[] = [];
  const disabled: Record<string, string> = {};
  for (const plugin of manifests()) for (const [name, delivery] of Object.entries(plugin.commands ?? {})) {
    if (!ids.has(plugin.id)) disabled[name] = disabledCommand(plugin, name);
    else if (delivery === 'queued') queued.push(name);
    else if (delivery === 'queuedWithPrompt') queuedWithPrompt.push(name);
    else if (delivery === 'immediateWithImages') withImages.push(name);
  }
  return { queued, queuedWithPrompt, withImages, disabled };
}

export function agentCommands(core: string[], enabledIds: readonly string[]): string[] {
  const names = new Set(core);
  for (const plugin of manifests()) if (enabledIds.includes(plugin.id)) for (const name of Object.keys(plugin.commands ?? {})) names.add(name);
  return [...names].sort();
}

// How clients show the custom messages of the plugins, by custom type. It holds for the messages of each plugin that
// this daemon has, also when the plugin is off.
export function messageDisplay(customType: string): NonNullable<PluginManifest['messages']>[string] | undefined {
  for (const plugin of manifests()) if (plugin.messages && Object.hasOwn(plugin.messages, customType)) return plugin.messages[customType];
  return undefined;
}

// The custom entries of the plugins that keep only their last value.
export function stateRecords(): string[] {
  return [...new Set(manifests().flatMap(plugin => plugin.stateRecords ?? []))];
}

function isMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const KINDS: Record<string, string> = { string: 'text', number: 'a number', boolean: 'true or false' };

export function parsePluginSettings(value: unknown): PluginSettings {
  if (value === undefined) return defaultPluginSettings();
  if (!isMap(value)) throw new Error('The plugin settings must be an object');
  const result: PluginSettings = {};
  for (const plugin of manifests()) {
    if (!plugin.settings) continue;
    const own = value[plugin.id] ?? {};
    if (!isMap(own)) throw new Error(`The settings of the plugin ${plugin.id} must be an object`);
    result[plugin.id] = Object.fromEntries(Object.entries(plugin.settings).map(([field, fallback]) => {
      const saved = own[field];
      if (saved === undefined) return [field, fallback];
      if (typeof saved !== typeof fallback) throw new Error(`The setting ${field} must be ${KINDS[typeof fallback]}`);
      return [field, saved];
    }));
  }
  return result;
}

export function defaultPluginSettings(): PluginSettings {
  return Object.fromEntries(manifests().flatMap(plugin => plugin.settings ? [[plugin.id, { ...plugin.settings }]] : []));
}
