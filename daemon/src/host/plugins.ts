import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as Endpoint from '../daemon_endpoint';
import * as RestartStorage from '../restart_storage';
import * as Contributions from '../plugin_contributions';
import { RwLock, errorText } from '../util/sync';

const BUNDLED = Contributions.CATALOG.map(plugin => plugin.id);

interface Configuration { enabled: string[]; previous: string[] }

function validate(enabled: unknown): asserts enabled is string[] {
  if (!Array.isArray(enabled) || enabled.some(id => typeof id !== 'string')) throw new Error('invalid type: expected a sequence of strings');
  const unique = new Set<string>();
  for (const id of enabled) {
    if (!BUNDLED.includes(id)) throw new Error('Unknown bundled plugin: ' + id);
    if (unique.has(id)) throw new Error('Duplicate plugin: ' + id);
    unique.add(id);
  }
}

function configurationPath(): string { return join(Endpoint.directory(), 'plugins.json'); }

function configuration(): Configuration {
  const value = RestartStorage.read(configurationPath());
  if (value === null) return { enabled: [...BUNDLED], previous: [] };
  const fail = (reason: string) => new Error('Could not read plugin configuration: ' + reason);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('invalid type: expected struct Configuration');
  for (const key of Object.keys(value)) if (key !== 'enabled' && key !== 'previous') throw fail('unknown field ' + key + ', expected enabled or previous');
  for (const key of ['enabled', 'previous']) {
    if (!(key in value)) throw fail('missing field ' + key);
    if (!Array.isArray(value[key]) || value[key].some((item: any) => typeof item !== 'string')) throw fail('invalid type for ' + key);
  }
  return { enabled: value.enabled, previous: value.previous };
}

/** Plugins only add Pi extensions, commands and settings, so a valid list of bundled plugins always starts. */
export async function validateConfiguration(_executable: string, enabled: string[]): Promise<void> { validate(enabled); }

interface State { enabled: string[]; revision: string; error: string | null }

export class PluginService {
  private state: State | null = null;
  private lock = new RwLock();

  async initialize(): Promise<void> {
    if (this.state) return;
    const release = await this.lock.write();
    try {
      if (this.state) return;
      const errors: string[] = [];
      let enabled: string[] = [];
      try {
        const config = configuration();
        try { validate(config.enabled); enabled = config.enabled; } catch (reason) {
          errors.push('Could not load the plugin setup: ' + errorText(reason) + '. Restored the previous setup.');
          try { validate(config.previous); enabled = config.previous; } catch (failure) { errors.push('The previous plugin setup is also invalid: ' + errorText(failure) + '. Plugins are disabled; your conversations remain available.'); }
        }
      } catch (reason) { errors.push(errorText(reason)); }
      Contributions.activate(enabled);
      this.state = { enabled: [...enabled], revision: randomUUID(), error: errors.length ? errors.join('\n') : null };
    } finally { release(); }
  }

  async handle(packet: any): Promise<any> {
    if (packet?.type === 'prepare_daemon_restart') return this.prepareRestart(packet);
    const release = await this.lock.read();
    try {
      const state = this.state;
      if (!state) throw new Error('Plugins are unavailable');
      if (packet?.type === 'plugin_status') return { enabled: [...state.enabled], configured: [...state.enabled], revision: state.revision, error: state.error };
      throw new Error('Unknown plugin operation');
    } finally { release(); }
  }

  private async prepareRestart(packet: any): Promise<any> {
    const enabled = packet?.enabled;
    validate(enabled);
    const release = await this.lock.write();
    try {
      const current = this.state;
      if (!current) throw new Error('Plugins are unavailable');
      if (packet.revision !== current.revision) throw new Error('Plugin setup changed in another client. Reload the plugin setup before restarting.');
      return { enabled, previous: [...current.enabled] };
    } finally { release(); }
  }

  async shutdown(): Promise<void> {
    const release = await this.lock.write();
    try { this.state = null; } finally { release(); }
  }
}
