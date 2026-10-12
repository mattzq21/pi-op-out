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
const NAMES: Record<string, string> = { chatgpt: 'ChatGPT', markdown: 'Notes', diff: 'Diff' };
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
  /** configured lists every requested plugin; enabled lists only those that started. */
  constructor(readonly configured: string[], readonly enabled: string[], readonly chatgpt: Sdk | null, readonly failures: string[]) {}

  /** Starts each plugin on its own, so one failed plugin does not stop the others. */
  static async load(executable: string, enabled: string[], events: Events): Promise<Runtime> {
    validate(enabled);
    const started: string[] = [];
    const failures: string[] = [];
    let chatgpt: Sdk | null = null;
    for (const id of enabled) {
      try {
        if (id === 'markdown') Markdown.initialize();
        else if (id === 'chatgpt') chatgpt = await startChatgpt(executable, events);
        started.push(id);
      } catch (error) { failures.push(NAMES[id] + ': ' + errorText(error)); }
    }
    return new Runtime([...enabled], started, chatgpt, failures);
  }

  async drain(disabling: boolean): Promise<boolean> {
    const sdk = this.chatgpt;
    if (!sdk) return true;
    let cancelled = false;
    const work = (async () => {
      while (!cancelled) {
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
        if (cancelled) return false;
        if (idle) return true;
        await sleep(200);
      }
      return false;
    })();
    try {
      const result = await timeout(work, 30_000);
      if (!result.done) throw new Error('ChatGPT is still responding. The previous plugins remain active; restart again when it finishes.');
      return result.value;
    } finally { cancelled = true; }
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
    if (tickets === null || tickets === undefined) return;
    if (this.chatgpt) await this.chatgpt.request({ method: 'plugin_restore', tickets });
    else if (pendingTickets(tickets)) throw new Error('ChatGPT did not start, so its pending requests and edit locks from before the restart were lost.');
  }
}

function pendingTickets(snapshot: any): boolean {
  if (Array.isArray(snapshot)) return snapshot.length > 0;
  return Boolean(snapshot?.tickets?.length || snapshot?.leases?.length);
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
  if (runtime.failures.length) throw new Error(runtime.failures.join('; '));
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
      stopped: error => {
        const state = this.state;
        if (!state?.runtime.chatgpt) return;
        const message = 'The ChatGPT worker stopped unexpectedly (' + errorText(error) + '). Replies in progress and edit locks were lost. ChatGPT starts again on the next request.';
        console.error(message);
        state.error = state.error ? state.error + '\n' + message : message;
        this.host?.output({ type: 'plugins_changed' });
      },
    };
  }

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
      const runtime = await Runtime.load(this.executable, enabled, this.events());
      if (runtime.failures.length) errors.push('Some plugins could not start: ' + runtime.failures.map(failure => failure.replace(/\.$/, '')).join('; ') + '. Restart the plugins to try again.');
      try { await runtime.restoreStartup(); } catch (reason) { errors.push(errorText(reason)); }
      this.state = { runtime, revision: randomUUID(), error: errors.length ? errors.join('\n') : null };
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
      if (packet?.type === 'plugin_status') return { enabled: [...state.runtime.enabled], configured: [...state.runtime.configured], revision: state.revision, error: state.error };
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
      return { enabled, previous: [...current.runtime.configured], tickets };
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
  const empty = { tickets: [], leases: [] };
  if (!(await runtime.drain(disabling))) return empty;
  const sdk = runtime.chatgpt;
  if (!sdk) return empty;
  try {
    const request = sdk.request({ method: 'plugin_checkpoint' });
    request.catch(() => {});
    const result = await timeout(request, 5_000);
    if (!result.done) throw new Error('ChatGPT checkpoint timed out');
    return result.value;
  } catch (error) {
    if (disabling) { console.error('Disabling ChatGPT without an in-memory checkpoint: ' + errorText(error)); return empty; }
    throw error;
  }
}
