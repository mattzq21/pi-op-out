import { realpath, readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const emit = (packet) => process.stdout.write(JSON.stringify(packet) + '\n');

const logins = new Map();

const cancelled = new Set();

const providerModelCatalogs = new WeakMap();

let initializing;

let fastModelDiscovery;

async function resolveExecutable() {
  const executable = process.argv[1] || 'pi';
  const expanded = executable.startsWith('~/') ? join(homedir(), executable.slice(2)) : executable;
  const candidates = /[/\\]/.test(expanded) ? [resolve(expanded)] : (process.env.PATH || '').split(delimiter).map((directory) => join(directory, expanded));
  let entry;

  for (const candidate of candidates) {
    try { entry = await realpath(candidate); break; } catch { }
  }

  if (!entry) throw new Error('Pi is unavailable on this host. Check its Pi executable setting.');

  return entry;
}

async function loadRuntime() {
  const entry = await resolveExecutable();
  let directory = dirname(entry);

  while (directory !== dirname(directory)) {
    let metadata;

    try { metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { }

    if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(metadata?.name)) {
      const sdk = await import(pathToFileURL(join(directory, 'dist/core/model-runtime.js')).href).catch(() => undefined);

      if (!sdk?.ModelRuntime?.create) break;
      await installRuntimeStorage(directory);
      const config = await import(pathToFileURL(join(directory, 'dist/config.js')).href);
      const { stripJsonComments } = await import(pathToFileURL(join(directory, 'dist/utils/json.js')).href);
      const { SettingsManager } = await import(pathToFileURL(join(directory, 'dist/core/settings-manager.js')).href);
      const resolver = await import(pathToFileURL(join(directory, 'dist/core/model-resolver.js')).href);
      const settings = SettingsManager.create(process.cwd(), config.getAgentDir());
      const builtin = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false }).catch(() => { throw new Error('Could not load provider configuration on this host. Check Pi configuration and file permissions.'); });

      return { runtime, settings, resolver, authPath: config.getAuthPath(), modelsPath: join(config.getAgentDir(), 'models.json'), parseModels: body => JSON.parse(stripJsonComments(body.replace(/^\uFEFF/, ''))), builtinIds: builtin.getProviders().map((provider) => provider.id) };
    }

    directory = dirname(directory);
  }

  throw new Error('Provider login requires a Pi Node installation with ModelRuntime support on this host. Update Pi and try again.');
}

function runtime() {
  initializing ??= loadRuntime().catch((error) => { initializing = undefined; throw error; });

  return initializing;
}

function providerMetadata(runtime, provider) {
  const methods = [];

  if (provider.auth.oauth) methods.push({ type: 'oauth', name: provider.auth.oauth.loginLabel || provider.auth.oauth.name, interactive: true, login: Boolean(provider.auth.oauth.login) });

  if (provider.auth.apiKey) methods.push({ type: 'api_key', name: provider.auth.apiKey.name, interactive: Boolean(provider.auth.apiKey.login), login: Boolean(provider.auth.apiKey.login) });
  const status = runtime.getProviderAuthStatus(provider.id);

  return { id: provider.id, name: provider.name, configured: status.configured, source: status.label ?? status.source, methods };
}

function providerModelObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerModelString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function providerModelValid(model) {
  if (!providerModelObject(model) || !providerModelString(model.id) || !providerModelString(model.provider)) return false;

  if (model.reasoning !== undefined && model.reasoning !== true && model.reasoning !== false) return false;

  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.every(providerModelString))) return false;

  return ['contextWindow', 'maxTokens'].every(field => model[field] === undefined || Number.isSafeInteger(model[field]) && model[field] > 0);
}

function providerModelCopy(model) {
  try {
    const copy = JSON.parse(JSON.stringify(model));

    if (providerModelValid(copy)) return copy;
  } catch { }
}

function providerModelGroups(entries, diagnostics) {
  const groups = new Map(); const failed = new Set();

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

function providerModelPrevious(runtime, providers) {
  let previous = providerModelCatalogs.get(runtime);

  if (!previous) { previous = new Map(); providerModelCatalogs.set(runtime, previous); }

  const ids = new Set(providers.map(provider => provider.id));

  for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);

  return { previous, ids };
}

function providerModelMerge(previous, ids, entries) {
  const diagnostics = [];
  const { groups, failed } = providerModelGroups(entries, diagnostics);
  const models = [];

  for (const id of groups.keys()) if (!ids.has(id)) {
    diagnostics.push({ providerId: id, message: 'SDK model records refer to an unavailable provider.' });
  }

  for (const id of ids) {
    const current = groups.get(id) ?? [];

    if (!failed.has(id)) previous.set(id, current);
    models.push(...(previous.get(id) ?? current));
  }

  for (const diagnostic of diagnostics) diagnostic.usingLastUsableCatalog = Boolean(previous.get(diagnostic.providerId)?.length);

  return { models, modelDiagnostics: diagnostics };
}

function providerModels(loaded, providers) {
  const { previous, ids } = providerModelPrevious(loaded.runtime, providers);
  let entries;

  try { entries = loaded.runtime.getModels(); } catch { }

  if (!Array.isArray(entries)) {
    const models = [...previous.values()].flat();

    return { models, modelDiagnostics: [{ message: 'The SDK model catalog is unavailable or is not an array.', usingLastUsableCatalog: models.length > 0 }] };
  }

  return providerModelMerge(previous, ids, entries);
}

async function prepareBrowserReturn(notice, login) {
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
      let returned;

      try { returned = new URL(request.url || '/', destination.origin); } catch { }
      const valid = returned !== undefined && request.method === 'GET' && returned.origin === destination.origin && returned.pathname === destination.pathname
        && returned.searchParams.get('state') === expectedState
        && (returned.searchParams.has('code') || returned.searchParams.has('error'));
      response.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!valid) { response.end('Invalid login return.'); return; }
      if (login.browserReturn !== undefined) { response.end('Login return already received. Return to Piop.'); return; }
      login.browserReturn = returned.href;
      login.browserError = returned.searchParams.has('error') ? 'The provider did not approve the login. Start again.' : undefined;
      login.answer?.(login.browserReturn);
      response.end('Login return received. Return to Piop to finish signing in.');
    });
    login.callbackServers.push(server);
    try {
      await new Promise((resolve, reject) => {
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

async function prompt(flowId, login, request) {
  if (login.key !== undefined) return Promise.resolve(login.key);
  if (request.type === 'manual_code') {
    await login.callbackReady;
    if (login.browserError) throw new Error(login.browserError);
    if (login.browserReturn !== undefined) return login.browserReturn;
  }
  const signals = [login.controller.signal, request.signal].filter(Boolean);

  if (signals.some((signal) => signal.aborted)) return Promise.reject(new Error('Login cancelled'));

  return new Promise((resolve, reject) => {
    const promptId = randomUUID();

    const finish = (answer) => {
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
    emit({ event: 'prompt', flowId, promptId, request: { type: request.type, message: request.message, placeholder: request.placeholder, options: request.options } });
  });
}

async function login(packet) {
  const state = { controller: new AbortController(), key: packet.key, callbackServers: [] };
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

function loginFailure(error, signal) {
  if (error?.operation === 'login' && error?.credential) return { status: 'complete' };

  if (signal.aborted) return { status: 'cancelled' };

  return { status: 'failed', error: error instanceof Error && error.message.trim() ? error.message.slice(0, 400) : 'Provider login failed. Check your details and try again.' };
}

function cancelLogin(packet) {
  const login = logins.get(packet.flowId);

  if (login) login.controller.abort();
  else { cancelled.add(packet.flowId);

  if (cancelled.size > 1024) cancelled.delete(cancelled.values().next().value); }
}

function answerLogin(packet) {
  const state = logins.get(packet.flowId);

  if (!state?.answer || state.promptId !== packet.promptId) throw new Error('This login prompt has expired');
  state.answer(packet.answer);
}

async function handle(packet) {
  if (packet.method === 'ping') return true;

  return handleRequest(packet);
}

async function handleRequest(packet) {
  if (packet.method === 'login') return login(packet);

  if (packet.method === 'cancel') return cancelLogin(packet);

  if (packet.method === 'answer') return answerLogin(packet);
  const loaded = await runtime();

  if (packet.method === 'initialize') return { builtinIds: loaded.builtinIds, authPath: loaded.authPath };

  if (['model_config', 'save_model_provider'].includes(packet.method)) return storedProviderRequest(loaded, packet);


  return handleProviderRequest(loaded, packet);
}

function storedProviderRequest(loaded, packet) {
  if (packet.method === 'model_config') return loaded.parseModels(storedModelText(loaded.modelsPath) ?? '{"providers":{}}');

  if (packet.method === 'save_model_provider') return saveStoredModelProvider(loaded.modelsPath, packet.providerId, packet.config, packet.previous ?? undefined, loaded.parseModels);

  throw new Error('Unknown provider storage request');
}

async function handleProviderRequest(loaded, packet) {
  if (packet.method === 'fast_model_scan') {
    fastModelDiscovery ??= createFastModelDiscovery(loaded.runtime);

    return fastModelDiscovery.scan(packet.provider ?? undefined);
  }

  if (packet.method === 'draft_catalog') {
    await loaded.runtime.refresh({ allowNetwork: false }).catch(() => { throw new Error('Could not refresh providers on this host. Check Pi configuration.'); });

    const initial = await initialSelection(loaded);

    return { models: await loaded.runtime.getAvailable(), initialModel: initial.model, initialThinking: initial.thinkingLevel };
  }

  if (packet.method === 'inspect') {
    const refreshDiagnostics = await refreshProviders(loaded.runtime);
    const credentials = await loaded.runtime.listCredentials().catch(() => { throw new Error('Could not read saved provider status on this host.'); });

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

/**
 * The model and thinking level that a new Pi session on this host starts with, before Piop's --thinking option and before Pi limits the level to what the model supports.
 * Follows Pi's own choice: the enabled models scope first, then the saved default, then the provider defaults. The model is "provider/id", or null when no model is available.
 */
async function initialSelection(loaded) {
  await loaded.settings.reload();
  const settings = loaded.settings;
  const patterns = settings.getEnabledModels();
  const scoped = patterns?.length ? await loaded.resolver.resolveModelScope(patterns, loaded.runtime, { signal: AbortSignal.timeout(15_000) }) : [];
  let model;
  let thinkingLevel;

  if (scoped.length) {
    const saved = settings.getDefaultProvider() && settings.getDefaultModel() ? loaded.runtime.getModel(settings.getDefaultProvider(), settings.getDefaultModel()) : undefined;
    const entry = (saved && scoped.find(item => item.model.provider === saved.provider && item.model.id === saved.id)) ?? scoped[0];
    model = entry.model;
    thinkingLevel = entry.thinkingLevel;
  } else {
    model = (await loaded.resolver.findInitialModel({ scopedModels: [], isContinuing: false, defaultProvider: settings.getDefaultProvider(), defaultModelId: settings.getDefaultModel(), defaultThinkingLevel: settings.getDefaultThinkingLevel(), modelThinkingLevels: settings.getAllModelThinkingLevels(), modelRuntime: loaded.runtime })).model;
  }

  thinkingLevel ??= (model && settings.getModelThinkingLevel(model.provider, model.id)) || settings.getDefaultThinkingLevel() || 'medium';

  return { model: model ? model.provider + '/' + model.id : null, thinkingLevel };
}

/** The SDK records configuration and provider errors during refresh and still resolves, so they are read back here. */
async function refreshProviders(runtime) {
  const result = await runtime.refresh({ allowNetwork: false }).catch(() => { throw new Error('Could not refresh providers on this host. Check Pi configuration.'); });
  const diagnostics = [];
  const seen = new Set();
  const add = (providerId, error) => {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.trim() || seen.has(message)) return;
    seen.add(message);
    diagnostics.push(providerId === undefined ? { message } : { providerId, message });
  };

  for (const [providerId, error] of result?.errors ?? []) add(providerId, error);

  const configuration = runtime.getError?.();

  if (configuration) add(undefined, configuration);

  return diagnostics;
}

const input = createInterface({ input: process.stdin });

input.on('line', (line) => {
  let packet;

  try { packet = JSON.parse(line); } catch { console.error('Pi provider SDK received an invalid request line'); return; }

  const fail = (error) => emit({ id: packet.id, error: error instanceof Error ? error.message : String(error) });

  Promise.resolve().then(() => handle(packet)).then(
    (data) => { try { emit({ id: packet.id, data: data ?? null }); } catch (error) { fail(new Error('Could not send the reply: ' + (error instanceof Error ? error.message : String(error)))); } },
    fail,
  ).catch((error) => console.error('Pi provider SDK could not reply:', error));
});

process.on('unhandledRejection', (error) => { console.error('Unhandled error in Pi provider SDK:', error); });

input.on('close', () => { for (const login of logins.values()) login.controller.abort(); process.exit(0); });

process.on('SIGTERM', () => { for (const login of logins.values()) login.controller.abort(); process.exit(0); });
