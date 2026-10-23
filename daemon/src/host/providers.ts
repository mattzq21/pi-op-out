import { randomUUID } from 'node:crypto';
import { Mutex, errorText } from '../util/sync';
import { array, flag, text, jsonEqual } from './json';
import * as Catalogs from './catalogs';
import { authText, authUrl } from './catalogs';
import { Sdk } from './provider_sdk';
import { FastModelStore, type FastModelScanResult, type FastModelSnapshot } from './fast_models';
import type { Host } from './controller';
import { join } from 'node:path';
import { savedCommands } from '../command_inventory';

/** One login attempt that a client started for a provider. */
class Flow {
  status = 'pending';
  notices: any[] = [];
  prompt: any | null = null;
  error: string | null = null;
  created = Date.now();
  constructor(readonly id: string, readonly owner: string, readonly providerId: string, readonly name: string) {}

  receivePrompt(packet: any): boolean {
    try { this.prompt = prompt(packet); return false; } catch (error) {
      this.status = 'failed';
      this.error = errorText(error);
      this.prompt = null;
      this.notices = [];
      return true;
    }
  }

  receiveNotice(packet: any): void {
    const value = notice(packet);
    if (!value) return;
    if (this.notices.length >= 16) this.notices.shift();
    this.notices.push(value);
  }

  snapshot(): any {
    const snapshot: any = { flowId: this.id, providerId: this.providerId, name: this.name, status: this.status, notices: structuredClone(this.notices) };
    if (this.prompt !== null) snapshot.prompt = structuredClone(this.prompt);
    if (this.error !== null) snapshot.error = this.error;
    return snapshot;
  }
}

const UNAVAILABLE = 'This login attempt is unavailable. Start again.';
function truncate(value: string, count: number): string { return Array.from(value).slice(0, count).join(''); }

export class ProviderService {
  private sdk: Sdk;
  private host: Host | undefined;
  private flows = new Map<string, Flow>();
  private busy = new Set<string>();
  private catalogWarning: string | null = null;
  private nextCatalog: number | null = null;
  private runtimeInfo: { builtinIds: Set<string> } | null = null;
  private runtimeGate = new Mutex();
  private catalogs = new Mutex();
  private fastModels: FastModelStore;
  private revision = 0;

  constructor(executable: string) {
    this.sdk = new Sdk(executable, { event: packet => this.receive(packet) });
    this.fastModels = new FastModelStore(
      { scan: provider => this.sdk.request({ method: 'fast_model_scan', provider: provider ?? null }) as Promise<FastModelScanResult[]> },
      () => this.host?.output({ type: 'fast_models_changed' }),
    );
  }

  bind(host: Host): void {
    this.host = host;
    this.refreshCatalogs(true).catch(error => host.output({ type: 'diagnostic', line: 'Provider model scan failed at startup: ' + errorText(error) }));
  }

  fastModelSnapshot(): FastModelSnapshot { return this.fastModels.snapshot(); }

  private changed(): void { this.flowChanged(null); }

  private flowChanged(flow: any | null): void {
    this.revision += 1;
    const host = this.host;
    if (!host) return;
    for (const session of [...host.sessions.values()]) session.publish({ type: 'session_info_changed' }, null);
    host.output({ type: 'provider_auth_changed', flow });
  }

  private async runtime(): Promise<{ builtinIds: Set<string> }> {
    return this.runtimeGate.run(async () => {
      if (this.runtimeInfo) return this.runtimeInfo;
      const info = await this.sdk.request({ method: 'initialize' });
      this.runtimeInfo = { builtinIds: new Set(array(info, 'builtinIds').filter(id => typeof id === 'string')) };
      return this.runtimeInfo;
    });
  }

  async refresh(): Promise<number> {
    await this.runtime();
    await this.refreshCatalogs(false);
    return this.revision;
  }

  async handle(owner: string, request: any): Promise<any> {
    if (!owner) throw new Error('Login owner is missing');
    switch (request?.action) {
      case 'fast_models': return this.fastModels.snapshot();
      case 'draft_catalog': return { ...await this.sdk.request({ method: 'draft_catalog' }), commandDetails: savedCommands(join(this.host!.home, this.host!.storage, 'settings.json')) };
      case 'list': return this.listing(flag(request, 'refreshModels'));
      case 'begin': return this.begin(owner, request);
      case 'logout': return this.logout(text(request, 'providerId'));
      case 'create': return this.createProvider(request);
    }
    return this.flowRequest(owner, request);
  }

  private async flowRequest(owner: string, request: any): Promise<any> {
    const id = text(request, 'flowId');
    const flow = this.flows.get(id);
    if (!flow || flow.owner !== owner) throw new Error(UNAVAILABLE);
    const snapshot = flow.snapshot();
    switch (request?.action) {
      case 'poll': return snapshot;
      case 'reply': return this.reply(id, request);
      case 'cancel': await this.cancel(id); return this.snapshot(id);
      default: throw new Error('Unknown provider authentication operation');
    }
  }

  private snapshot(id: string): any {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(UNAVAILABLE);
    return flow.snapshot();
  }

  private async listing(refresh: boolean): Promise<any> {
    await this.runtime();
    await this.refreshCatalogs(refresh);
    const snapshot = await this.sdk.request({ method: 'inspect' });
    const credentials = array(snapshot, 'credentials');
    const providers = array(snapshot, 'providers').map(provider => listedProvider(provider, credentials)).filter(provider => array(provider, 'methods').length > 0);
    providers.sort((left, right) => { const a = text(left, 'id'); const b = text(right, 'id'); return a < b ? -1 : a > b ? 1 : 0; });
    const result: any = { providers };
    const warnings = [this.catalogWarning, providerModelWarning(snapshot), fastModelWarning(this.fastModels.snapshot())].filter((item): item is string => item !== null);
    if (warnings.length) result.warning = warnings.join('\n');
    return result;
  }

  private async begin(owner: string, request: any): Promise<any> {
    await this.runtime();
    const snapshot = await this.sdk.request({ method: 'inspect' });
    const provider = array(snapshot, 'providers').find(provider => jsonEqual(provider?.id, request?.providerId));
    if (!provider) throw new Error('Provider is unavailable on this host');
    this.validateLogin(provider, request);
    const flow = new Flow(randomUUID(), owner, text(provider, 'id'), text(provider, 'name'));
    const result = flow.snapshot();
    this.startLogin(flow, request?.authType ?? null);
    return result;
  }

  private validateLogin(provider: any, request: any): void {
    const authType = request?.authType;
    if (!(authType === 'oauth' || authType === 'api_key') || !array(provider, 'methods').some(method => method?.type === authType && flag(method, 'login'))) {
      throw new Error('This provider uses credentials configured on the host');
    }
    for (const [id, flow] of [...this.flows]) if (!(flow.status === 'pending' || Date.now() - flow.created <= 600_000)) this.flows.delete(id);
    if (this.flows.size >= 32) throw new Error('Too many login attempts. Try again later.');
    if (this.busy.has(text(provider, 'id'))) throw new Error('A credential operation is already running for this provider');
  }

  private startLogin(flow: Flow, authType: any): void {
    const providerId = flow.providerId;
    const id = flow.id;
    if (this.busy.has(providerId)) throw new Error('A credential operation is already running for this provider');
    this.busy.add(providerId);
    this.flows.set(id, flow);
    void (async () => {
      let result: { ok: true; value: any } | { ok: false; error: string };
      let timer: NodeJS.Timeout | undefined;
      const login = this.sdk.request({ method: 'login', flowId: id, providerId, authType });
      login.catch(() => {});
      const expired = Symbol('expired');
      try {
        const value = await Promise.race([login, new Promise(resolve => { timer = setTimeout(() => resolve(expired), 600_000); })]);
        if (value === expired) { await this.cancel(id); result = { ok: true, value: { status: 'cancelled' } }; }
        else result = { ok: true, value };
      } catch (error) {
        result = { ok: false, error: errorText(error) };
      } finally { clearTimeout(timer); }
      this.busy.delete(providerId);
      if (result.ok && result.value?.status === 'complete') void this.fastModels.scan(providerId);
      const current = this.flows.get(id);
      if (current) {
        if (current.status === 'pending' || (current.status === 'cancelled' && result.ok && result.value?.status === 'complete')) {
          if (result.ok) {
            current.status = typeof result.value?.status === 'string' ? result.value.status : 'failed';
            current.error = typeof result.value?.error === 'string' ? truncate(result.value.error, 400) : null;
          } else {
            current.status = 'failed';
            current.error = truncate(result.error, 400);
          }
        }
        current.prompt = null;
        current.notices = [];
      }
      let snapshot: any = null;
      try { snapshot = this.snapshot(id); } catch {}
      this.flowChanged(snapshot);
    })();
  }

  private async reply(id: string, request: any): Promise<any> {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(UNAVAILABLE);
    const current = flow.prompt;
    if (!current || flow.status !== 'pending' || !jsonEqual(current.id, request?.promptId)) throw new Error('This login prompt has expired');
    const answer = request?.answer;
    if (typeof answer !== 'string' || answer.length > 128 * 1024) throw new Error('Invalid login answer');
    if (current.type === 'select' && !array(current, 'options').some(option => option?.id === answer)) throw new Error('Choose one of the available options');
    await this.sdk.request({ method: 'answer', flowId: id, promptId: request?.promptId ?? null, answer: request?.answer ?? null });
    return this.snapshot(id);
  }

  async cancelOwner(owner: string): Promise<void> {
    const ids = [...this.flows.values()].filter(flow => flow.owner === owner).map(flow => flow.id);
    await Promise.all(ids.map(id => this.cancel(id)));
  }

  private async cancel(id: string): Promise<void> {
    const flow = this.flows.get(id);
    if (!flow || flow.status !== 'pending') return;
    await this.sdk.request({ method: 'cancel', flowId: id });
    if (flow.status !== 'pending') return;
    flow.status = 'cancelled';
    flow.prompt = null;
    flow.notices = [];
  }

  private async logout(id: string): Promise<any> {
    await this.runtime();
    const snapshot = await this.sdk.request({ method: 'inspect' });
    if (!array(snapshot, 'providers').some(provider => provider?.id === id)) throw new Error('Provider is unavailable on this host');
    if (this.busy.has(id)) throw new Error('Finish or cancel the current login first');
    this.busy.add(id);
    let failed = false;
    try { await this.sdk.request({ method: 'logout', providerId: id }); } catch { failed = true; }
    this.busy.delete(id);
    this.changed();
    void this.fastModels.scan(id);
    if (failed) throw new Error('Could not remove the saved provider login. Refresh and try again.');
    return this.listing(false);
  }

  private async createProvider(request: any): Promise<any> {
    const config = Catalogs.customConfig(request);
    const key = customKey(request);
    const snapshot = await this.sdk.request({ method: 'inspect' });
    const id = text(request, 'providerId');
    if (array(snapshot, 'providers').some(provider => provider?.id === id)) throw new Error('That provider ID already exists. Choose another ID.');
    config.models = await Catalogs.discover(config, key, array(snapshot, 'models'), null);
    await this.sdk.request({ method: 'save_model_provider', providerId: id, config });
    let confirmed = true;
    try { await this.loginCreatedProvider(id, key); } catch { confirmed = false; }
    this.changed();
    await this.fastModels.scan(id);
    const result: any = { created: true };
    if (!confirmed) result.warning = 'Provider created, but its login could not be confirmed. Refresh and use Add account to save the key.';
    return result;
  }

  private async loginCreatedProvider(id: string, key: string | null): Promise<void> {
    await this.sdk.request({ method: 'inspect' });
    if (key === null) return;
    const login = await this.sdk.request({ method: 'login', flowId: randomUUID(), providerId: id, authType: 'api_key', key });
    if (login?.status !== 'complete') throw new Error('Provider login could not be confirmed');
  }

  private async refreshCatalogs(force: boolean): Promise<void> {
    await this.catalogs.run(async () => {
      if (!force && this.nextCatalog !== null && Date.now() < this.nextCatalog) return;
      this.nextCatalog = Date.now() + 300_000;
      await Promise.all([this.refreshCustomCatalogs(), this.fastModels.scan()]);
    });
  }

  /** Regular model scans cover custom providers only; fast model scans have their own provider filter. */
  private async refreshCustomCatalogs(): Promise<void> {
    const info = await this.runtime();
    const snapshot = await this.sdk.request({ method: 'inspect' });
    const data = await this.sdk.request({ method: 'model_config' });
    const models = array(snapshot, 'models');
    const providers = data?.providers && typeof data.providers === 'object' && !Array.isArray(data.providers) ? Object.entries<any>(data.providers) : [];
    const catalogs = providers.filter(([id, config]) => !info.builtinIds.has(id) && authUrl(config?.baseUrl) !== null && Catalogs.supportedApi(config));
    const results = await Promise.all(catalogs.map(async ([id, config]) => { try { await this.refreshCatalog(id, config, models); return null; } catch { return id; } }));
    const failures = results.filter((id): id is string => id !== null);
    this.catalogWarning = failures.length ? 'Could not refresh models for ' + failures.join(', ') + '. Keeping the last successful catalog.' : null;
  }

  private async refreshCatalog(id: string, config: any, models: any[]): Promise<void> {
    const auth = await this.sdk.request({ method: 'auth', providerId: id });
    if (auth === null || auth === undefined) throw new Error('Provider login is missing');
    const key = typeof auth.apiKey === 'string' ? auth.apiKey : null;
    const discovered = await Catalogs.discover(config, key, models, auth.headers ?? null);
    const next = { ...config, models: Catalogs.mergeModels(config, discovered) };
    if (!jsonEqual(next, config)) {
      await this.sdk.request({ method: 'save_model_provider', providerId: id, config: next, previous: config });
      this.changed();
    }
  }

  private receive(packet: any): void {
    const id = text(packet, 'flowId');
    const flow = this.flows.get(id);
    if (!flow || flow.status !== 'pending') return;
    let cancel = false;
    switch (packet?.event) {
      case 'prompt': cancel = flow.receivePrompt(packet); break;
      case 'prompt_resolved': if (flow.prompt && jsonEqual(flow.prompt.id, packet.promptId)) flow.prompt = null; break;
      case 'notice': flow.receiveNotice(packet.notice); break;
    }
    if (cancel) this.sdk.request({ method: 'cancel', flowId: id }).catch(() => {});
  }

  async shutdown(): Promise<void> {
    for (const flow of this.flows.values()) {
      if (flow.status !== 'pending') continue;
      flow.status = 'cancelled';
      flow.prompt = null;
      flow.notices = [];
    }
    await this.sdk.shutdown();
  }
}

function fastModelWarning(snapshot: FastModelSnapshot): string | null {
  const warnings = [snapshot.error, ...Object.values(snapshot.providers).map(provider => provider.error)].filter((item): item is string => item !== undefined);
  return warnings.length ? warnings.join('\n') : null;
}

function providerModelWarning(snapshot: any): string | null {
  const warnings = array(snapshot, 'modelDiagnostics').map(providerModelDiagnostic).filter((item): item is string => item !== null);
  return warnings.length ? warnings.join('\n') : null;
}

function providerModelDiagnostic(diagnostic: any): string | null {
  const message = diagnostic?.message;
  if (typeof message !== 'string' || !message.trim()) return null;
  const provider = typeof diagnostic.providerId === 'string' ? diagnostic.providerId + ': ' : '';
  const retained = diagnostic.usingLastUsableCatalog === true ? ' Using the last usable model catalog.' : '';
  return provider + message + retained;
}

function customKey(request: any): string | null {
  if (flag(request, 'noKey')) return null;
  const raw = request?.apiKey;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || raw.length > 32768) throw new Error('Enter the API key, or select No API key required');
  return key;
}

function listedProvider(provider: any, credentials: any[]): any {
  const result = structuredClone(provider);
  const credential = credentials.find(item => jsonEqual(item?.providerId, result?.id));
  if (credential) result.storedType = credential.type ?? null;
  if (Array.isArray(result?.methods)) for (const method of result.methods) if (method && typeof method === 'object' && !Array.isArray(method)) delete method.login;
  return result;
}

function notice(event: any): any | null {
  switch (event?.type) {
    case 'auth_url': return { type: 'auth_url', url: authUrl(event.url), message: authText(event.instructions) };
    case 'device_code': return { type: 'device_code', url: authUrl(event.verificationUri), userCode: authText(event.userCode) };
    case 'info': case 'progress':
      return { type: event.type, message: authText(event.message), links: array(event, 'links').slice(0, 8).map(link => ({ url: authUrl(link?.url), label: authText(link?.label) })) };
    default: return null;
  }
}

function prompt(packet: any): any {
  const request = packet?.request;
  if (!['text', 'secret', 'select', 'manual_code'].includes(request?.type)) throw new Error('Unsupported provider login prompt');
  const result: any = { id: packet.promptId ?? null, type: request.type, message: authText(request.message), placeholder: authText(request.placeholder) };
  if (request.type === 'select') result.options = array(request, 'options').map(option => ({ id: authText(option?.id), label: authText(option?.label), description: authText(option?.description) }));
  return result;
}
