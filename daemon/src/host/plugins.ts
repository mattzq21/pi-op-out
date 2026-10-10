import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as Endpoint from '../daemon_endpoint';
import * as DaemonRestart from '../daemon_restart';
import * as RestartStorage from '../restart_storage';
import { chatgptService, chatgptStorage, chatgptStream } from '../resources';
import { RwLock, errorText, sleep } from '../util/sync';
import * as Markdown from './markdown';
import { Sdk, type Events } from './provider_sdk';
import type { Host } from './controller';

export { preserveLeasesForRestart } from './markdown';

const BUNDLED = ['chatgpt', 'markdown', 'diff'];
const CHATGPT_SOURCE = chatgptStream + '\n' + chatgptStorage + '\n' + chatgptService +
  '\nconst bundledPlugin = { call: handleChatGpt, idle: chatGptIdle, checkpoint: chatGptTicketSnapshot, restore: chatGptRestore };';

interface Configuration { enabled: string[]; previous: string[] }

function timeout<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(value => ({ done: true as const, value })),
    new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** The set of plugins that runs now, with the ChatGPT worker when it is enabled. */
class Runtime {
  constructor(readonly enabled: string[], readonly chatgpt: Sdk | null) {}

  static async load(executable: string, enabled: string[], events: Events): Promise<Runtime> {
    validate(enabled);
    let chatgpt: Sdk | null = null;
    for (const id of enabled) {
      if (id === 'markdown') {
        try { Markdown.initialize(); } catch (error) { if (chatgpt) await chatgpt.shutdown(); throw error; }
      } else if (id === 'chatgpt') chatgpt = await startChatgpt(executable, events);
    }
    return new Runtime(enabled, chatgpt);
  }

  async drain(disabling: boolean): Promise<boolean> {
    const sdk = this.chatgpt;
    if (!sdk) return true;
    const work = (async () => {
      for (;;) {
        let idle: boolean;
        try {
          const result = await timeout(sdk.request({ method: 'plugin_idle' }), 5_000);
          if (!result.done) throw new Error('ChatGPT worker did not respond to the restart readiness check');
          if (typeof result.value !== 'boolean') throw new Error('ChatGPT worker returned an invalid readiness response');
          idle = result.value;
        } catch (error) {
          if (disabling) { console.error('Disabling unavailable ChatGPT worker: ' + errorText(error)); return false; }
          throw error;
        }
        if (idle) return true;
        await sleep(200);
      }
    })();
    const result = await timeout(work, 30_000);
    if (!result.done) { work.catch(() => {}); throw new Error('ChatGPT is still responding. The previous plugins remain active; restart again when it finishes.'); }
    return result.value;
  }

  async shutdown(): Promise<void> { await this.chatgpt?.shutdown(); }

  async call(packet: any): Promise<any> {
    const id = packet?.pluginId;
    if (typeof id !== 'string') throw new Error('Missing plugin ID');
    const enabled = this.enabled.includes(id);
    if (id === 'markdown') return Markdown.dispatch(packet.request ?? null, enabled);
    if (!enabled) throw new Error('The ' + id + ' plugin is disabled on this daemon');
    if (id === 'chatgpt') {
      if (!this.chatgpt) throw new Error('ChatGPT plugin is unavailable');
      return this.chatgpt.request({ method: 'plugin_call', request: packet.request ?? null });
    }
    throw new Error('Unknown plugin: ' + id);
  }

  async restoreStartup(): Promise<void> {
    const tickets = DaemonRestart.startupTickets();
    if (tickets !== null && tickets !== undefined && this.chatgpt) await this.chatgpt.request({ method: 'plugin_restore', tickets });
  }
}

async function startChatgpt(executable: string, events: Events): Promise<Sdk> {
  const sdk = Sdk.plugin(executable, events, CHATGPT_SOURCE);
  let error: string | null = null;
  const request = sdk.request({ method: 'initialize' });
  try {
    const result = await timeout(request, 20_000);
    if (!result.done) error = 'ChatGPT plugin startup timed out';
    else if (typeof result.value?.authPath !== 'string') error = 'ChatGPT plugin returned an invalid startup response';
  } catch (reason) { error = errorText(reason); }
  request.catch(() => {});
  if (error !== null) { await sdk.shutdown(); throw new Error(error); }
  return sdk;
}

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

export async function validateConfiguration(executable: string, enabled: string[]): Promise<void> {
  const runtime = await Runtime.load(executable, enabled, { event() {} });
  await runtime.shutdown();
}

interface State { runtime: Runtime; revision: string; error: string | null }

export class PluginService {
  private state: State | null = null;
  private lock = new RwLock();
  private host: Host | undefined;

  constructor(private executable: string) {}

  bind(host: Host): void { this.host = host; }

  private events(): Events {
    return {
      event: packet => {
        if (packet?.event !== 'chatgpt_changed') return;
        this.host?.output({ type: 'chatgpt_changed', providerId: packet.providerId ?? null, scope: packet.scope ?? null });
      },
    };
  }

  async initialize(): Promise<void> {
    if (this.state) return;
    const release = await this.lock.write();
    try {
      if (this.state) return;
      let config: Configuration;
      let error: string | null = null;
      try { config = configuration(); } catch (reason) { config = { enabled: [], previous: [] }; error = errorText(reason); }
      const events = this.events();
      let runtime: Runtime;
      try { runtime = await Runtime.load(this.executable, config.enabled, events); } catch (reason) {
        error = 'Could not load the plugin setup: ' + errorText(reason) + '. Restored the previous setup.';
        try { runtime = await Runtime.load(this.executable, config.previous, events); } catch (failure) {
          error = 'Plugins could not start: ' + errorText(failure) + '. Plugins are disabled; your conversations remain available.';
          runtime = new Runtime([], null);
        }
      }
      try { await runtime.restoreStartup(); } catch (reason) { error = errorText(reason); }
      this.state = { runtime, revision: randomUUID(), error };
    } finally { release(); }
  }

  async handle(packet: any): Promise<any> {
    if (packet?.type === 'plugin_idle') return this.idle();
    if (packet?.type === 'prepare_daemon_restart') return this.prepareRestart(packet);
    const release = await this.lock.read();
    let runtime: Runtime;
    try {
      const state = this.state;
      if (!state) throw new Error('Plugins are unavailable');
      if (packet?.type === 'plugin_status') return { enabled: [...state.runtime.enabled], revision: state.revision, error: state.error };
      runtime = state.runtime;
    } finally { release(); }
    return runtime.call(packet);
  }

  private async idle(): Promise<any> {
    const release = await this.lock.read();
    let sdk: Sdk | null;
    try { sdk = this.state?.runtime.chatgpt ?? null; } finally { release(); }
    return sdk ? sdk.request({ method: 'plugin_idle' }) : true;
  }

  private async prepareRestart(packet: any): Promise<any> {
    const enabled = packet?.enabled;
    validate(enabled);
    const release = await this.lock.write();
    try {
      const current = this.state;
      if (!current) throw new Error('Plugins are unavailable');
      if (packet.revision !== current.revision) throw new Error('Plugin setup changed in another client. Reload the plugin setup before restarting.');
      const tickets = await checkpoint(current.runtime, !enabled.includes('chatgpt'));
      return { enabled, previous: [...current.runtime.enabled], tickets };
    } finally { release(); }
  }

  async shutdown(): Promise<void> {
    const release = await this.lock.write();
    try {
      const state = this.state;
      this.state = null;
      await state?.runtime.shutdown();
    } finally { release(); }
  }
}

async function checkpoint(runtime: Runtime, disabling: boolean): Promise<any> {
  if (!(await runtime.drain(disabling))) return [];
  const sdk = runtime.chatgpt;
  if (!sdk) return [];
  try {
    const request = sdk.request({ method: 'plugin_checkpoint' });
    request.catch(() => {});
    const result = await timeout(request, 5_000);
    if (!result.done) throw new Error('ChatGPT checkpoint timed out');
    return result.value;
  } catch (error) {
    if (disabling) { console.error('Disabling ChatGPT without an in-memory checkpoint: ' + errorText(error)); return []; }
    throw error;
  }
}
