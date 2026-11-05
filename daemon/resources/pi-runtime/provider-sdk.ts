import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Api, AuthEvent, AuthPrompt, AuthType, Model, Provider } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type * as PiModelRuntime from '@earendil-works/pi-coding-agent/dist/core/model-runtime.js';
import type * as PiConfig from '@earendil-works/pi-coding-agent/dist/config.js';
import type * as PiJson from '@earendil-works/pi-coding-agent/dist/utils/json.js';
import type * as PiSettingsManager from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import type * as PiModelResolver from '@earendil-works/pi-coding-agent/dist/core/model-resolver.js';
import type * as PiSkills from '@earendil-works/pi-coding-agent/dist/core/skills.js';
import { installRuntimeStorage, removeStoredModelProvider, saveStoredModelProvider, storedModelText } from './sdk-storage.ts';
import { storageChannel } from '../session-database/index.ts';
import { createFastModelDiscovery } from './fast-models.ts';
import { OCX_PROVIDER_ID, ocxProviderConfig } from '../../../pi-extensions/piop-ocx-provider/ocx-provider.ts';

// The SDK takes its storage channel before it starts any program, so those programs do not get it.
storageChannel.claim();

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

const emit = (packet: unknown) => process.stdout.write(JSON.stringify(packet) + '\n');

type LoginState = {
  controller: AbortController;
  key?: string;
  callbackServers: Server[];
  callbackReady?: Promise<void>;
  automaticReturn?: boolean;
  answer?: (answer: string | null) => void;
  promptId?: string;
  browserReturn?: string;
  browserError?: string;
};

type ModelDiagnostic = { providerId?: string; message: string; usingLastUsableCatalog?: boolean };

type ProviderRequest =
  | { method: 'ping' | 'initialize' | 'model_config' | 'inspect' }
  | { method: 'login'; flowId: string; providerId: string; authType: AuthType; key?: string }
  | { method: 'cancel'; flowId: string }
  | { method: 'answer'; flowId: string; promptId: string | null; answer: string | null }
  | { method: 'save_model_provider'; providerId: string; config: unknown; previous?: unknown }
  | { method: 'remove_model_provider' | 'logout' | 'auth'; providerId: string }
  | { method: 'fast_model_scan'; provider?: string | null }
  | { method: 'draft_catalog'; skillPaths: unknown };

type ProviderPacket = ProviderRequest & { id: string };

type ProviderModel = { id: string; provider: string } & Record<string, unknown>;

type LoadedRuntime = Awaited<ReturnType<typeof loadRuntime>>;

const logins = new Map<string, LoginState>();

const cancelled = new Set<string>();

const providerModelCatalogs = new WeakMap<ModelRuntime, Map<string, ProviderModel[]>>();

let initializing: Promise<LoadedRuntime> | undefined;

let fastModelDiscovery: ReturnType<typeof createFastModelDiscovery> | undefined;

async function loadRuntime() {
  const directory = process.argv[2];

  if (!directory) throw new Error('The daemon did not give the Pi installation folder');
  const sdk: typeof PiModelRuntime = await import(pathToFileURL(join(directory, 'dist/core/model-runtime.js')).href);
  await installRuntimeStorage(directory);
  const config: typeof PiConfig = await import(pathToFileURL(join(directory, 'dist/config.js')).href);
  const { stripJsonComments }: typeof PiJson = await import(pathToFileURL(join(directory, 'dist/utils/json.js')).href);
  const { SettingsManager }: typeof PiSettingsManager = await import(pathToFileURL(join(directory, 'dist/core/settings-manager.js')).href);
  const resolver: typeof PiModelResolver = await import(pathToFileURL(join(directory, 'dist/core/model-resolver.js')).href);
  const { loadSkills }: typeof PiSkills = await import(pathToFileURL(join(directory, 'dist/core/skills.js')).href);
  const settings = SettingsManager.create(process.cwd(), config.getAgentDir());
  const builtin = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false }).catch((error) => { throw new Error(`Could not load provider configuration on this host: ${reason(error)}. Check Pi configuration and file permissions.`); });
  await refreshOcx(runtime);

  return { runtime, settings, resolver, loadSkills, agentDir: config.getAgentDir(), authPath: config.getAuthPath(), modelsPath: join(config.getAgentDir(), 'models.json'), parseModels: (body: string): unknown => JSON.parse(stripJsonComments(body.replace(/^\uFEFF/, ''))), builtinIds: builtin.getProviders().map((provider) => provider.id) };
}

function runtime(): Promise<LoadedRuntime> {
  initializing ??= loadRuntime().catch((error) => { initializing = undefined; throw error; });

  return initializing;
}

async function refreshOcx(runtime: ModelRuntime): Promise<{ providerId: string; message: string } | undefined> {
  let config;

  try { config = await ocxProviderConfig(homedir()); } catch (error) { return { providerId: OCX_PROVIDER_ID, message: error instanceof Error ? error.message : String(error) }; }

  if (config) runtime.registerProvider(OCX_PROVIDER_ID, config);
  else if (runtime.getRegisteredProviderIds().includes(OCX_PROVIDER_ID)) runtime.unregisterProvider(OCX_PROVIDER_ID);

  return undefined;
}

function providerMetadata(runtime: ModelRuntime, provider: Provider) {
  if (provider.id === OCX_PROVIDER_ID) return { id: provider.id, name: provider.name, configured: runtime.getProviderAuthStatus(provider.id).configured, source: 'built in', methods: [], builtin: true };
  const methods: { type: string; name: string; interactive: boolean; login: boolean }[] = [];

  if (provider.auth.oauth) methods.push({ type: 'oauth', name: provider.auth.oauth.loginLabel || provider.auth.oauth.name, interactive: true, login: Boolean(provider.auth.oauth.login) });

  if (provider.auth.apiKey) methods.push({ type: 'api_key', name: provider.auth.apiKey.name, interactive: Boolean(provider.auth.apiKey.login), login: Boolean(provider.auth.apiKey.login) });
  const status = runtime.getProviderAuthStatus(provider.id);

  return { id: provider.id, name: provider.name, configured: status.configured, source: status.label ?? status.source, methods };
}

function providerModelObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerModelString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function providerModelCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function providerModelValid(model: unknown): model is ProviderModel {
  if (!providerModelObject(model) || !providerModelString(model.id) || !providerModelString(model.provider)) return false;

  if (model.reasoning !== undefined && model.reasoning !== true && model.reasoning !== false) return false;

  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.every(providerModelString))) return false;

  return ['contextWindow', 'maxTokens'].every(field => model[field] === undefined || providerModelCount(model[field]));
}

function providerModelCopy(model: unknown): ProviderModel | undefined {
  try {
    const copy = JSON.parse(JSON.stringify(model));

    if (providerModelValid(copy)) return copy;
  } catch {}
}

function providerModelGroups(entries: readonly unknown[], diagnostics: ModelDiagnostic[]) {
  const groups = new Map<string, ProviderModel[]>(); const failed = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const model = providerModelCopy(entry);

    if (!model) {
      const providerId = providerModelObject(entry) && providerModelString(entry.provider) ? entry.provider : undefined;

      if (providerId) failed.add(providerId);
      diagnostics.push({ providerId, message: `Invalid SDK model record at position ${index + 1}.` });
      continue;
    }

    const group = groups.get(model.provider) ?? [];
    group.push(model); groups.set(model.provider, group);
  }

  return { groups, failed };
}

function providerModelPrevious(runtime: ModelRuntime, providers: readonly Provider[]) {
  let previous = providerModelCatalogs.get(runtime);

  if (!previous) { previous = new Map(); providerModelCatalogs.set(runtime, previous); }

  const ids = new Set(providers.map(provider => provider.id));

  for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);

  return { previous, ids };
}

function providerModelMerge(previous: Map<string, ProviderModel[]>, ids: Set<string>, entries: readonly unknown[]) {
  const diagnostics: ModelDiagnostic[] = [];
  const { groups, failed } = providerModelGroups(entries, diagnostics);
  const models: unknown[] = [];

  for (const id of groups.keys()) if (!ids.has(id)) {
    diagnostics.push({ providerId: id, message: 'SDK model records refer to an unavailable provider.' });
  }

  for (const id of ids) {
    const current = groups.get(id) ?? [];

    if (!failed.has(id)) previous.set(id, current);
    models.push(...(previous.get(id) ?? current));
  }

  for (const diagnostic of diagnostics) diagnostic.usingLastUsableCatalog = Boolean(diagnostic.providerId !== undefined && previous.get(diagnostic.providerId)?.length);

  return { models, modelDiagnostics: diagnostics };
}

function providerModels(loaded: LoadedRuntime, providers: readonly Provider[]) {
  const { previous, ids } = providerModelPrevious(loaded.runtime, providers);
  let entries: readonly Model<Api>[] | undefined;

  let failure: string | undefined;

  try { entries = loaded.runtime.getModels(); } catch (error) { failure = error instanceof Error ? error.message : String(error); }

  if (!Array.isArray(entries)) {
    const models = [...previous.values()].flat();

    return { models, modelDiagnostics: [{ message: failure === undefined ? 'The SDK model catalog is not an array.' : `The SDK model catalog is unavailable: ${failure}`, usingLastUsableCatalog: models.length > 0 }] };
  }

  return providerModelMerge(previous, ids, entries);
}

async function prepareBrowserReturn(notice: AuthEvent, login: LoginState) {
  if (notice.type !== 'auth_url' || !notice.url) return;
  const authorization = new URL(notice.url);
  const redirect = authorization.searchParams.get('redirect_uri');
  if (!redirect) return;
  const destination = new URL(redirect);
  if (destination.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)) return;
  const expectedState = authorization.searchParams.get('state');
  if (!expectedState) return;

  const hosts = destination.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [destination.hostname.replace(/^\[|\]$/g, '')];
  for (const host of hosts) {
    if (login.controller.signal.aborted) throw new Error('Login cancelled');
    const server = createServer((request, response) => {
      const returned = (() => { try { return new URL(request.url || '/', destination.origin); } catch { return undefined; } })();
      const valid = returned !== undefined && request.method === 'GET' && returned.origin === destination.origin && returned.pathname === destination.pathname
        && returned.searchParams.get('state') === expectedState
        && (returned.searchParams.has('code') || returned.searchParams.has('error'));
      response.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!valid) { response.end('Invalid login return.'); return; }
      if (login.browserReturn !== undefined) { response.end('Login return already received. Return to Piop.'); return; }
      login.browserReturn = returned.href;
      login.browserError = returned.searchParams.has('error') ? 'The provider did not approve the login. Start again.' : undefined;
      login.answer?.(returned.href);
      response.end('Login return received. Return to Piop to finish signing in.');
    });
    login.callbackServers.push(server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port: Number(destination.port || 80), ipv6Only: host === '::1' }, () => {
          server.off('error', reject);
          server.on('error', () => login.controller.abort());
          resolve();
        });
      });
      if (login.controller.signal.aborted) { server.close(); throw new Error('Login cancelled'); }
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE' && !(host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code))) {
        throw new Error('Could not start the automatic browser return receiver. Cancel login and try again.');
      }
    }
  }
  login.automaticReturn = true;
}

async function prompt(flowId: string, login: LoginState, request: AuthPrompt): Promise<string> {
  if (login.key !== undefined) return Promise.resolve(login.key);
  if (request.type === 'manual_code') {
    await login.callbackReady;
    if (login.browserError) throw new Error(login.browserError);
    if (login.browserReturn !== undefined) return login.browserReturn;
  }
  const signals = [login.controller.signal, request.signal].filter((signal): signal is AbortSignal => Boolean(signal));

  if (signals.some((signal) => signal.aborted)) return Promise.reject(new Error('Login cancelled'));

  return new Promise((resolve, reject) => {
    const promptId = randomUUID();

    const finish = (answer: string | null) => {
      for (const signal of signals) signal.removeEventListener('abort', abort);

      if (login.promptId === promptId) { login.answer = undefined; login.promptId = undefined; }

      emit({ event: 'prompt_resolved', flowId, promptId });

      if (answer === null) reject(new Error('Login cancelled'));
      else if (login.browserError) reject(new Error(login.browserError));
      else resolve(answer);
    };

    const abort = () => finish(null);
    login.promptId = promptId; login.answer = finish;

    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    emit({ event: 'prompt', flowId, promptId, request: { type: request.type, message: request.message, placeholder: 'placeholder' in request ? request.placeholder : undefined, options: 'options' in request ? request.options : undefined } });
  });
}

async function login(packet: Extract<ProviderRequest, { method: 'login' }>) {
  const state: LoginState = { controller: new AbortController(), key: packet.key, callbackServers: [] };
  logins.set(packet.flowId, state);

  if (cancelled.delete(packet.flowId)) state.controller.abort();

  try {
    const loaded = await runtime();
    await loaded.runtime.login(packet.providerId, packet.authType, {
      signal: state.controller.signal,
      prompt: (request) => prompt(packet.flowId, state, request),
      notify: (notice) => {
        if (state.controller.signal.aborted) return;
        if (packet.providerId === 'anthropic' && notice.type === 'auth_url') {
          state.callbackReady = prepareBrowserReturn(notice, state).then(() => {
            if (!state.controller.signal.aborted) emit({ event: 'notice', flowId: packet.flowId, notice: state.automaticReturn ? { ...notice, instructions: 'Complete login in your browser. Piop receives the result automatically when the browser is on this computer.' } : notice });
          });
          void state.callbackReady.catch(() => undefined);
        } else emit({ event: 'notice', flowId: packet.flowId, notice });
      },
    }, { getDeviceId: () => loaded.settings.getOrCreateDeviceId() });


    return { status: 'complete' };
  } catch (error) {
    return loginFailure(error, state.controller.signal);
  } finally { state.answer?.(null); for (const server of state.callbackServers) server.close(); logins.delete(packet.flowId); }
}

function loginFailure(error: Partial<PiModelRuntime.CredentialSynchronizationError> | null | undefined, signal: AbortSignal) {
  if (error?.operation === 'login' && error?.credential) return { status: 'complete' };

  if (signal.aborted) return { status: 'cancelled' };

  return { status: 'failed', error: error instanceof Error && error.message.trim() ? error.message.slice(0, 400) : 'Provider login failed. Check your details and try again.' };
}

function cancelLogin(packet: Extract<ProviderRequest, { method: 'cancel' }>) {
  const login = logins.get(packet.flowId);

  if (login) login.controller.abort();
  else { cancelled.add(packet.flowId);

  if (cancelled.size > 1024) cancelled.delete(cancelled.values().next().value!); }
}

function answerLogin(packet: Extract<ProviderRequest, { method: 'answer' }>) {
  const state = logins.get(packet.flowId);

  if (!state?.answer || state.promptId !== packet.promptId) throw new Error('This login prompt has expired');
  state.answer(packet.answer);
}

async function handle(packet: ProviderRequest) {
  if (packet.method === 'ping') return true;

  return handleRequest(packet);
}

async function handleRequest(packet: ProviderRequest) {
  if (packet.method === 'login') return login(packet);

  if (packet.method === 'cancel') return cancelLogin(packet);

  if (packet.method === 'answer') return answerLogin(packet);
  const loaded = await runtime();

  if (packet.method === 'initialize') return { builtinIds: loaded.builtinIds, authPath: loaded.authPath };

  if (['model_config', 'save_model_provider', 'remove_model_provider'].includes(packet.method)) return storedProviderRequest(loaded, packet);


  return handleProviderRequest(loaded, packet);
}

function storedProviderRequest(loaded: LoadedRuntime, packet: ProviderRequest) {
  if (packet.method === 'model_config') return loaded.parseModels(storedModelText(loaded.modelsPath) ?? '{"providers":{}}');

  if (packet.method === 'save_model_provider') return saveStoredModelProvider(loaded.modelsPath, packet.providerId, packet.config, packet.previous ?? undefined, loaded.parseModels);

  if (packet.method === 'remove_model_provider') {
    return loaded.runtime.logout(packet.providerId).then(() => removeStoredModelProvider(loaded.modelsPath, packet.providerId, loaded.parseModels));
  }

  throw new Error('Unknown provider storage request');
}

async function handleProviderRequest(loaded: LoadedRuntime, packet: ProviderRequest) {
  if (packet.method === 'fast_model_scan') {
    fastModelDiscovery ??= createFastModelDiscovery(loaded.runtime);

    return fastModelDiscovery.scan(packet.provider ?? undefined);
  }

  if (packet.method === 'draft_catalog') {
    await refreshOcx(loaded.runtime);
    await loaded.runtime.refresh({ allowNetwork: false }).catch((error) => { throw new Error(`Could not refresh providers on this host: ${reason(error)}. Check Pi configuration.`); });

    const initial = await initialSelection(loaded);

    return { models: await loaded.runtime.getAvailable(), initialModel: initial.model, initialThinking: initial.thinkingLevel, skills: sessionSkills(loaded, packet.skillPaths) };
  }

  if (packet.method === 'inspect') {
    const refreshDiagnostics = await refreshProviders(loaded.runtime);
    const credentials = await loaded.runtime.listCredentials().catch((error) => { throw new Error(`Could not read saved provider status on this host: ${reason(error)}`); });

    const providers = loaded.runtime.getProviders();
    const { models, modelDiagnostics } = providerModels(loaded, providers);

    return { providers: providers.map((provider) => providerMetadata(loaded.runtime, provider)), models, modelDiagnostics: [...refreshDiagnostics, ...modelDiagnostics], credentials: credentials.map(({ providerId, type }) => ({ providerId, type })) };
  }

  if (packet.method === 'logout') { await loaded.runtime.logout(packet.providerId);

  return; }

  if (packet.method === 'auth') {
    const resolution = await loaded.runtime.getAuth(packet.providerId);

    return resolution ? { apiKey: resolution.auth.apiKey, headers: resolution.auth.headers } : null;
  }

  throw new Error('Unknown provider SDK operation');
}

function sessionSkills(loaded: LoadedRuntime, skillPaths: unknown) {
  if (!Array.isArray(skillPaths) || skillPaths.some(path => typeof path !== 'string')) throw new Error('Invalid skill paths');

  return skillPaths.length ? loaded.loadSkills({ cwd: homedir(), agentDir: loaded.agentDir, skillPaths, includeDefaults: false }).skills.map(skill => ({ name: skill.name, description: skill.description })) : [];
}

async function initialSelection(loaded: LoadedRuntime) {
  await loaded.settings.reload();
  const settings = loaded.settings;
  const patterns = settings.getEnabledModels();
  const scoped = patterns?.length ? await loaded.resolver.resolveModelScope(patterns, loaded.runtime, { signal: AbortSignal.timeout(15_000) }) : [];
  let model;
  let thinkingLevel;

  if (scoped.length) {
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();
    const saved = defaultProvider && defaultModel ? loaded.runtime.getModel(defaultProvider, defaultModel) : undefined;
    const entry = (saved && scoped.find(item => item.model.provider === saved.provider && item.model.id === saved.id)) ?? scoped[0];
    model = entry.model;
    thinkingLevel = entry.thinkingLevel;
  } else {
    model = (await loaded.resolver.findInitialModel({ scopedModels: [], isContinuing: false, defaultProvider: settings.getDefaultProvider(), defaultModelId: settings.getDefaultModel(), defaultThinkingLevel: settings.getDefaultThinkingLevel(), modelThinkingLevels: settings.getAllModelThinkingLevels(), modelRuntime: loaded.runtime })).model;
  }

  thinkingLevel ??= (model && settings.getModelThinkingLevel(model.provider, model.id)) || settings.getDefaultThinkingLevel() || 'medium';

  return { model: model ? model.provider + '/' + model.id : null, thinkingLevel };
}

async function refreshProviders(runtime: ModelRuntime) {
  const ocx = await refreshOcx(runtime);
  const result = await runtime.refresh({ allowNetwork: false }).catch((error) => { throw new Error(`Could not refresh providers on this host: ${reason(error)}. Check Pi configuration.`); });
  const diagnostics: ModelDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (providerId: string | undefined, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.trim() || seen.has(message)) return;
    seen.add(message);
    diagnostics.push(providerId === undefined ? { message } : { providerId, message });
  };

  if (ocx) add(ocx.providerId, ocx.message);

  for (const [providerId, error] of result?.errors ?? []) add(providerId, error);

  const configuration = runtime.getError?.();

  if (configuration) add(undefined, configuration);

  return diagnostics;
}

// Requests end only at LF; node:readline would also split at U+2028 and U+2029 inside JSON strings.
const receiveRequest = (line: string) => {
  let packet: ProviderPacket;

  try { packet = JSON.parse(line); } catch { console.error('Pi provider SDK received an invalid request line'); return; }

  const fail = (error: unknown) => emit({ id: packet.id, error: error instanceof Error ? error.message : String(error) });

  Promise.resolve().then(() => handle(packet)).then(
    (data) => { try { emit({ id: packet.id, data: data ?? null }); } catch (error) { fail(new Error('Could not send the reply: ' + (error instanceof Error ? error.message : String(error)))); } },
    fail,
  ).catch((error) => console.error('Pi provider SDK could not reply:', error));
};

let pendingRequest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const lines = (pendingRequest + chunk).split('\n');
  pendingRequest = lines.pop() ?? '';
  for (const line of lines) receiveRequest(line.endsWith('\r') ? line.slice(0, -1) : line);
});
process.stdin.on('end', () => { if (pendingRequest) receiveRequest(pendingRequest); pendingRequest = ''; });

process.on('unhandledRejection', (error) => { console.error('Unhandled error in Pi provider SDK:', error); });

process.stdin.on('close', () => { for (const login of logins.values()) login.controller.abort(); process.exit(0); });

process.on('SIGTERM', () => { for (const login of logins.values()) login.controller.abort(); process.exit(0); });
