import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as Endpoint from '../service';
import * as Records from '../../resources/application-records.cjs';
import * as Contributions from '../plugins';
import { catalog } from '../plugins';
import type { PluginStatus } from '../../../protocol/plugins';
import { RwLock, errorText } from '../util/sync';

const known = () => catalog().plugins.map(plugin => plugin.manifest.id);

const enabledByDefault = () => catalog().plugins.filter(plugin => plugin.manifest.enabledByDefault !== false).map(plugin => plugin.manifest.id);

// The saved plugin setup: the enabled plugins, the setup before the last restart and the plugins that this setup knows.
const configurationSchema = z.strictObject({ enabled: z.array(z.string()), previous: z.array(z.string()), known: z.array(z.string()) });

type Configuration = z.output<typeof configurationSchema>;

export function restartConfiguration(enabled: string[], previous: string[]): Configuration {
  return { enabled, previous, known: known() };
}

function validate(enabled: string[]): void {
  const unique = new Set<string>();
  for (const id of enabled) {
    if (!known().includes(id)) throw new Error('Unknown plugin: ' + id);
    if (unique.has(id)) throw new Error('Duplicate plugin: ' + id);
    unique.add(id);
  }
}

// Saves the plugin setup of this storage root.
export function saveConfiguration(config: Configuration): void {
  Records.save(Endpoint.directory(), 'plugins', JSON.stringify(config));
}

function configuration(): Configuration | null {
  const value = Records.readJson(Endpoint.directory(), 'plugins');
  if (value === undefined) return null;
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw new Error('Could not read plugin configuration: ' + z.prettifyError(parsed.error));
  return parsed.data;
}

function withNewPlugins(config: Configuration): Configuration {
  const added = known().filter(id => !config.known.includes(id));
  if (!added.length) return config;
  const next = { enabled: [...config.enabled, ...added.filter(id => enabledByDefault().includes(id) && !config.enabled.includes(id))], previous: config.previous, known: [...new Set([...config.known, ...added])] };
  saveConfiguration(next);
  return next;
}

export async function validateConfiguration(enabled: string[]): Promise<void> { validate(enabled); }

interface State { enabled: string[]; revision: string; error: string | null }

// Leaves out the enabled plugins that this daemon does not have, for example a plugin whose folder was removed.
function installed(enabled: string[], errors: string[]): string[] {
  const missing = enabled.filter(id => !known().includes(id));
  if (missing.length) errors.push('These enabled plugins are not installed, so they are off: ' + missing.join(', '));
  return enabled.filter(id => !missing.includes(id));
}

export class PluginService {
  private state: State | null = null;
  private lock = new RwLock();

  async initialize(): Promise<void> {
    if (this.state) return;
    const release = await this.lock.write();
    try {
      if (this.state) return;
      const errors: string[] = [...catalog().errors];
      let enabled: string[] = [];
      try {
        const saved = configuration();
        const config = saved === null ? restartConfiguration(enabledByDefault(), []) : withNewPlugins(saved);
        try { enabled = installed(config.enabled, errors); validate(enabled); } catch (reason) {
          enabled = [];
          errors.push('Could not load the plugin setup: ' + errorText(reason) + '. Restored the previous setup.');
          try { const previous = installed(config.previous, []); validate(previous); enabled = previous; } catch (failure) { errors.push('The previous plugin setup is also invalid: ' + errorText(failure) + '. Plugins are disabled; your conversations remain available.'); }
        }
      } catch (reason) { errors.push(errorText(reason)); }
      Contributions.activate(enabled);
      this.state = { enabled: [...enabled], revision: randomUUID(), error: errors.length ? errors.join('\n') : null };
    } finally { release(); }
  }

  async status(): Promise<PluginStatus> {
    const release = await this.lock.read();
    try {
      const state = this.state;
      if (!state) throw new Error('Plugins are unavailable');
      return {
        enabled: [...state.enabled], configured: [...state.enabled], revision: state.revision, error: state.error,
        plugins: catalog().plugins.map(({ manifest: { id, name, keybinds, messages, auxiliary, client } }) => ({ id, name, keybinds, messages, auxiliary, client })),
        queuedCommands: Contributions.commandPolicy().queued,
        queuedWithPrompt: Contributions.commandPolicy().queuedWithPrompt,
      };
    } finally { release(); }
  }

  // The client part of an enabled plugin.
  async client(id: string): Promise<{ source: string }> {
    const release = await this.lock.read();
    try {
      if (!this.state) throw new Error('Plugins are unavailable');
      const plugin = Contributions.find(id);
      if (!plugin || !this.state.enabled.includes(id)) throw new Error('The plugin ' + id + ' is not enabled');
      if (plugin.client === undefined) throw new Error('The plugin ' + id + ' has no client part');
      return { source: plugin.client };
    } finally { release(); }
  }

  // Checks the plugin setup that a restart is to use, against the setup that the client saw.
  async prepareRestart(request: { enabled: string[]; revision: string }): Promise<{ enabled: string[]; previous: string[] }> {
    const enabled = request.enabled;
    validate(enabled);
    const release = await this.lock.write();
    try {
      const current = this.state;
      if (!current) throw new Error('Plugins are unavailable');
      if (request.revision !== current.revision) throw new Error('Plugin setup changed in another client. Reload the plugin setup before restarting.');
      return { enabled: [...enabled], previous: [...current.enabled] };
    } finally { release(); }
  }

  async shutdown(): Promise<void> {
    const release = await this.lock.write();
    try { this.state = null; } finally { release(); }
  }
}
