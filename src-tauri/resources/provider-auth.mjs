import { realpath as authRealpath, readFile as authReadFile, stat as authStat, mkdir as authMkdir } from 'node:fs/promises';
import { spawn as authSpawn } from 'node:child_process';
import { delimiter as authDelimiter, dirname as authDirname, join as authJoin, resolve as authResolve } from 'node:path';
import { homedir as authHomedir } from 'node:os';
import { pathToFileURL as authFileUrl } from 'node:url';
import { randomUUID as authUuid } from 'node:crypto';

async function providerAuthEntry(executable) {
  const expanded = executable.startsWith('~/') ? authJoin(authHomedir(), executable.slice(2)) : executable;
  const candidates = /[/\\]/.test(expanded) ? [authResolve(expanded)] : (process.env.PATH ?? '').split(authDelimiter).map((directory) => authJoin(directory, expanded));
  for (const candidate of candidates) {
    try { return await authRealpath(candidate); } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Pi is unavailable on this host. Check its Pi executable setting.');
}

async function providerAuthRuntime(executable) {
  const entry = await providerAuthEntry(executable);
  let directory = authDirname(entry);
  while (directory !== authDirname(directory)) {
    let metadata;
    try { metadata = JSON.parse(await authReadFile(authJoin(directory, 'package.json'), 'utf8')); } catch { /* Not a package root. */ }
    if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(metadata?.name)) {
      const sdk = await import(authFileUrl(authJoin(directory, 'dist/core/model-runtime.js')).href).catch(() => undefined);
      if (!sdk?.ModelRuntime?.create) break;
      const config = await import(authFileUrl(authJoin(directory, 'dist/config.js')).href);
      const builtins = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false }).catch(() => { throw new Error('Could not load provider configuration on this host. Check Pi configuration and file permissions.'); });
      return { runtime, builtinIds: new Set(builtins.getProviders().map((provider) => provider.id)), authPath: config.getAuthPath(), createRuntime: () => sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }) };
    }
    directory = authDirname(directory);
  }
  throw new Error('Provider login requires a Pi Node installation with ModelRuntime support on this host. Update Pi and try again.');
}

function authText(value) { return typeof value === 'string' ? value.slice(0, 8192) : ''; }

function customProviderConfig(request) {
  validateCustomProviderEndpoint(request);
  const config = { name: authText(request.name).trim() || request.providerId, baseUrl: authUrl(request.baseUrl).replace(/\/$/, ''), api: request.api };
  if (request.noKey === true) { config.apiKey = 'not-required'; config.authHeader = false; }
  if (request.sessionAffinity === true) config.compat = { sessionAffinityFormat: 'openai' };
  return config;
}

function validateCustomProviderEndpoint(request) {
  if (typeof request.providerId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(request.providerId) || request.providerId.includes('--piop-account-')) throw new Error('Use a unique provider ID containing lowercase letters, numbers, hyphens or underscores');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(request.api)) throw new Error('Choose a supported API format');
  const url = authUrl(request.baseUrl);
  if (!url || new URL(url).username || new URL(url).password) throw new Error('Enter an HTTP or HTTPS API URL without embedded credentials');
}

function discoveredModel(entry, known) {
  if (typeof entry?.id !== 'string' || !entry.id.trim()) throw new Error('The models endpoint returned an invalid model ID');
  const result = { id: entry.id, name: authText(entry.name || entry.display_name) || entry.id };
  const baseline = known.find((model) => model.id === entry.id);
  for (const field of ['reasoning', 'input', 'contextWindow', 'maxTokens']) {
    if (baseline?.[field] !== undefined) result[field] = baseline[field];
  }
  applyDiscoveredCapabilities(result, entry);
  applyDiscoveredLimits(result, entry);
  return result;
}

function applyDiscoveredCapabilities(result, entry) {
  if (typeof entry.reasoning === 'boolean') result.reasoning = entry.reasoning;
  if (Array.isArray(entry.input) && entry.input.every((item) => ['text', 'image'].includes(item))) result.input = entry.input;
}

function applyDiscoveredLimits(result, entry) {
  const limits = { contextWindow: entry.contextWindow ?? entry.context_length ?? entry.context_window, maxTokens: entry.maxTokens ?? entry.max_output_tokens ?? entry.max_tokens };
  for (const [field, value] of Object.entries(limits)) if (Number.isSafeInteger(value) && value > 0) result[field] = value;
}

function discoveryHeaders(config, key, extra) {
  const headers = { ...extra, accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (config.api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  }
  return headers;
}

async function fetchModelPage(url, headers, signal) {
  let response;
  try { response = await fetch(url, { headers, signal, redirect: 'error' }); }
  catch { throw new Error('Could not discover models. Check the API URL and connectivity from the selected host.'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Model discovery returned HTTP ${response.status}. Check the API URL and key.`); }
  return readModelCatalog(response);
}

async function discoverCustomModels(config, key, known, extraHeaders) {
  const url = new URL(config.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  const headers = discoveryHeaders(config, key, extraHeaders);
  const models = new Map();
  const signal = AbortSignal.timeout(15000);
  for (let page = 0; page < 50; page++) {
    const body = await fetchModelPage(url, headers, signal);
    const entries = Array.isArray(body) ? body : body.data;
    if (!Array.isArray(entries)) throw new Error('Expected a models endpoint returning a data array');
    for (const entry of entries) { const model = discoveredModel(entry, known); models.set(model.id, model); }
    if (!body.has_more) {
      if (!models.size) throw new Error('The provider returned no models');
      return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    if (typeof body.last_id !== 'string' || body.last_id === url.searchParams.get('after_id')) throw new Error('Invalid model catalog pagination');
    url.searchParams.set('after_id', body.last_id);
  }
  throw new Error('Model catalog exceeds the pagination limit');
}

async function readModelCatalog(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error('Model catalog is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Models endpoint did not return valid JSON'); }
}

async function saveCustomProvider(path, providerId, config, previous) {
  await authMkdir(authDirname(path), { recursive: true, mode: 0o700 });
  const script = `
    const fs = require('node:fs');
    const path = process.argv[1];
    const { providerId, config, previous } = JSON.parse(fs.readFileSync(0, 'utf8'));
    let data = { providers: {} };
    try { data = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') process.exit(2); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) process.exit(2);
    if (previous) {
      if (JSON.stringify(data.providers[providerId]) !== JSON.stringify(previous)) process.exit(4);
      if (JSON.stringify(previous) === JSON.stringify(config)) process.exit(0);
    } else if (Object.hasOwn(data.providers, providerId)) process.exit(3);
    Object.defineProperty(data.providers, providerId, { value: config, enumerable: true });
    const temporary = path + '.' + require('node:crypto').randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, path);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  `;
  await new Promise((resolve, reject) => {
    const child = authSpawn('flock', ['--exclusive', '--wait', '10', `${path}.lock`, process.execPath, '-e', script, path], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ providerId, config, previous }));
    child.once('error', () => reject(new Error('Could not save the provider. The host requires flock.')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else if (code === 3) reject(new Error('That provider ID already exists. Choose another ID.'));
      else reject(new Error('Could not save the provider. Check models.json and host file permissions.'));
    });
  });
}
function authUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

function authNotice(event) {
  if (event.type === 'auth_url') return { type: event.type, url: authUrl(event.url), message: authText(event.instructions) };
  if (event.type === 'device_code') return { type: event.type, url: authUrl(event.verificationUri), userCode: authText(event.userCode) };
  if (['info', 'progress'].includes(event.type)) return { type: event.type, message: authText(event.message), links: (event.links ?? []).slice(0, 8).map((link) => ({ url: authUrl(link.url), label: authText(link.label) })) };
  return undefined;
}

function authPrompt(request) {
  if (!['text', 'secret', 'select', 'manual_code'].includes(request.type)) throw new Error('Unsupported provider login prompt');
  const result = { id: authUuid(), type: request.type, message: authText(request.message), placeholder: authText(request.placeholder) };
  if (request.type === 'select') result.options = request.options.map((option) => ({ id: authText(option.id), label: authText(option.label), description: authText(option.description) }));
  return result;
}

function authAnswer(flow, request) {
  const prompt = flow.prompt;
  if (typeof request.answer !== 'string' || request.answer.length > 128 * 1024) throw new Error('Invalid login answer');
  if (prompt.type === 'select' && !prompt.options.some((option) => option.id === request.answer)) throw new Error('Choose one of the available options');
  return request.answer;
}

function waitForAuthAnswer(flow, request) {
  const signals = [flow.controller.signal, request.signal].filter(Boolean);
  if (signals.some((signal) => signal.aborted)) return Promise.reject(new Error('Login cancelled'));
  return new Promise((resolve, reject) => {
    const prompt = authPrompt(request);
    const finish = (answer) => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
      if (flow.prompt?.id === prompt.id) { flow.prompt = undefined; flow.answer = undefined; }
      if (answer === null) reject(new Error('Login cancelled')); else resolve(answer);
    };
    const abort = () => finish(null);
    flow.prompt = prompt;
    flow.answer = finish;
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
  });
}

class ProviderAuthService {
  constructor(executable, changed) {
    this.executable = executable;
    this.changed = changed;
    this.flows = new Map();
    this.busy = new Set();
    this.credentialTimer = setInterval(() => { void this.checkForChanges().catch(() => undefined); }, 2000);
    this.credentialTimer.unref();
  }

  runtime() {
    this.initializing ??= providerAuthRuntime(this.executable).then(({ runtime, builtinIds, authPath, createRuntime }) => {
      this.authPath = authPath;
      this.builtinIds = builtinIds;
      this.createRuntime = createRuntime;
      this.accounts = new Map();
      return runtime;
    }).catch((error) => { this.initializing = undefined; throw error; });
    return this.initializing;
  }

  async checkForChanges() {
    this.checkingCredentials ??= (async () => {
      await this.runtime();
      await this.refreshCustomModels();
      let revision;
      try {
        revision = await Promise.all([this.authPath, providerAccountsPath(this.authPath), authJoin(authDirname(this.authPath), 'models.json')].map(async (path) => {
          try { const stat = await authStat(path, { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
          catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
        })).then((values) => values.join('|'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Could not check provider credentials on this host');
        revision = 'missing';
      }
      if (revision !== this.credentialRevision) {
        this.credentialRevision = revision;
        this.changed();
      }
    })().finally(() => { this.checkingCredentials = undefined; });
    return this.checkingCredentials;
  }

  snapshot(flow) {
    return { flowId: flow.id, providerId: flow.providerId, name: flow.name, status: flow.status, notices: flow.notices, prompt: flow.prompt, error: flow.error };
  }

  cancelOwner(owner) {
    for (const flow of this.flows.values()) if (flow.owner === owner) this.cancel(flow);
  }

  shutdown() {
    clearInterval(this.credentialTimer);
    for (const flow of this.flows.values()) this.cancel(flow);
  }

  cancel(flow) {
    if (flow.status !== 'pending') return;
    flow.controller.abort();
    flow.status = 'cancelled';
    flow.prompt = undefined;
    flow.notices = [];
  }

  async listing(refreshModels = false) {
    if (refreshModels) this.nextCatalogRefresh = 0;
    const runtime = await this.runtime();
    await this.refreshCustomModels();
    await this.syncAccounts(runtime);
    await runtime.refresh({ allowNetwork: false }).catch(() => { throw new Error('Could not refresh providers on this host. Check Pi configuration.'); });
    const credentials = await runtime.listCredentials().catch(() => { throw new Error('Could not read saved provider status on this host.'); });
    const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
    return { warning: this.catalogWarning, providers: runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const methods = [];
      if (provider.auth.oauth) methods.push({ type: 'oauth', name: provider.auth.oauth.loginLabel || provider.auth.oauth.name, interactive: true });
      if (provider.auth.apiKey) methods.push({ type: 'api_key', name: provider.auth.apiKey.name, interactive: Boolean(provider.auth.apiKey.login) });
      const account = this.accountRecords.find((record) => record.id === provider.id);
      return { id: provider.id, providerId: account?.providerId ?? provider.id, number: account?.number ?? 1, name: account ? provider.name : `${provider.name} #1`, configured: status.configured, source: status.label ?? status.source, storedType: stored.get(provider.id), methods };
    }).filter((provider) => provider.methods.length).sort((left, right) => left.providerId.localeCompare(right.providerId) || left.number - right.number) };
  }

  async begin(owner, request) {
    const runtime = await this.runtime();
    await this.syncAccounts(runtime);
    let provider = runtime.getProvider(request.providerId);
    if (!provider) throw new Error('Provider is unavailable on this host');
    if (!['oauth', 'api_key'].includes(request.authType) || !provider.auth[request.authType === 'oauth' ? 'oauth' : 'apiKey']?.login) throw new Error('This provider uses credentials configured on the host');
    this.prune();
    if (this.flows.size >= 32) throw new Error('Too many login attempts. Try again later.');
    if (this.busy.has(provider.id)) throw new Error('A credential operation is already running for this provider');
    if (request.addAccount) provider = await this.addAccount(runtime, provider.id);
    const flow = { id: authUuid(), owner, providerId: provider.id, name: this.accounts.has(provider.id) ? provider.name : `${provider.name} #1`, controller: new AbortController(), status: 'pending', notices: [], createdAt: Date.now() };
    this.flows.set(flow.id, flow);
    this.busy.add(provider.id);
    const timer = setTimeout(() => this.cancel(flow), 10 * 60_000);
    timer.unref();
    void this.login(runtime, flow, request.authType).finally(() => { clearTimeout(timer); this.busy.delete(provider.id); });
    return this.snapshot(flow);
  }

  async addAccount(runtime, id) {
    const baseId = this.accountRecords.find((record) => record.id === id)?.providerId ?? id;
    const credentials = await runtime.listCredentials();
    const occupied = [...runtime.getProviders().map((item) => item.id), ...credentials.map((item) => item.providerId)];
    const record = await allocateProviderAccount(this.authPath, baseId, occupied);
    await this.syncAccounts(runtime);
    if (!runtime.getProvider(record.id)) await this.syncAccounts(runtime);
    const provider = runtime.getProvider(record.id);
    if (!provider) throw new Error('Could not initialize the new provider account');
    this.changed();
    return provider;
  }

  async login(runtime, flow, type) {
    try {
      await runtime.login(flow.providerId, type, {
        signal: flow.controller.signal,
        prompt: (request) => waitForAuthAnswer(flow, request),
        notify: (event) => {
          if (flow.status !== 'pending') return;
          const notice = authNotice(event);
          if (notice) flow.notices = [...flow.notices.slice(-15), notice];
        },
      });
      if (this.accounts.has(flow.providerId)) await runtime.refresh({ providers: [flow.providerId], allowNetwork: true, signal: flow.controller.signal });
      flow.status = 'complete';
    } catch (error) {
      if (error?.operation === 'login' && error?.credential) {
        flow.status = 'complete';
      } else if (flow.controller.signal.aborted) {
        flow.status = 'cancelled';
      } else {
        flow.status = 'failed';
      flow.error = error instanceof Error && error.message.trim() ? error.message.slice(0, 400) : 'Provider login failed. Check your details and try again.';
      }
    } finally {
      flow.prompt = undefined;
      flow.answer = undefined;
      flow.notices = [];
      this.changed();
    }
  }

  prune() {
    for (const [id, flow] of this.flows) if (flow.status !== 'pending' && Date.now() - flow.createdAt > 10 * 60_000) this.flows.delete(id);
  }

  ownedFlow(owner, id) {
    const flow = this.flows.get(id);
    if (!flow || flow.owner !== owner) throw new Error('This login attempt is unavailable. Start again.');
    return flow;
  }

  reply(flow, request) {
    if (flow.status !== 'pending' || !flow.answer || flow.prompt?.id !== request.promptId) throw new Error('This login prompt has expired');
    const answer = authAnswer(flow, request);
    flow.answer(answer);
    return this.snapshot(flow);
  }

  async logout(providerId) {
    const runtime = await this.runtime();
    await this.syncAccounts(runtime);
    if (!runtime.getProvider(providerId)) throw new Error('Provider is unavailable on this host');
    if (this.busy.has(providerId)) throw new Error('Finish or cancel the current login first');
    this.busy.add(providerId);
    try { await runtime.logout(providerId); }
    catch { throw new Error('Could not remove the saved provider login. Refresh and try again.'); }
    finally { this.busy.delete(providerId); this.changed(); }
    return this.listing();
  }

  async handle(owner, request) {
    if (typeof owner !== 'string' || !owner) throw new Error('Login owner is missing');
    if (request.action === 'list') return this.listing(request.refreshModels);
    if (request.action === 'begin') return this.begin(owner, request);
    if (request.action === 'logout') return this.logout(request.providerId);
    if (request.action === 'create') return this.createProvider(request);
    const flow = this.ownedFlow(owner, request.flowId);
    if (request.action === 'poll') return this.snapshot(flow);
    if (request.action === 'reply') return this.reply(flow, request);
    if (request.action === 'cancel') { this.cancel(flow); return this.snapshot(flow); }
    throw new Error('Unknown provider authentication operation');
  }

  async createProvider(request) {
    const config = customProviderConfig(request);
    if (request.noKey !== true && (typeof request.apiKey !== 'string' || !request.apiKey.trim() || request.apiKey.length > 32768)) throw new Error('Enter the API key, or select No API key required');
    const runtime = await this.runtime();
    await runtime.refresh({ allowNetwork: false });
    if (runtime.getProvider(request.providerId)) throw new Error('That provider ID already exists. Choose another ID.');
    config.models = await discoverCustomModels(config, request.noKey ? undefined : request.apiKey.trim(), runtime.getModels());
    await saveCustomProvider(authJoin(authDirname(this.authPath), 'models.json'), request.providerId, config);
    let warning;
    try {
      await runtime.refresh({ allowNetwork: false });
      if (request.noKey !== true) await runtime.login(request.providerId, 'api_key', { prompt: async () => request.apiKey.trim(), notify: () => {} });
    } catch {
      warning = 'Provider created, but its login could not be confirmed. Refresh and use Add account to save the key.';
    }
    this.changed();
    return { created: true, warning };
  }

  async refreshCustomModels() {
    if (this.refreshingCatalogs) return this.refreshingCatalogs;
    if (Date.now() < (this.nextCatalogRefresh || 0)) return;
    this.nextCatalogRefresh = Date.now() + 5 * 60_000;
    this.refreshingCatalogs = this.updateCustomCatalogs().finally(() => { this.refreshingCatalogs = undefined; });
    return this.refreshingCatalogs;
  }

  async updateCustomCatalogs() {
    const runtime = await this.runtime();
    await runtime.refresh({ allowNetwork: false });
    const path = authJoin(authDirname(this.authPath), 'models.json');
    let data;
    try { data = JSON.parse(await authReadFile(path, 'utf8')); }
    catch { return; }
    const failures = [];
    await Promise.all(Object.entries(data.providers ?? {}).map(async ([id, config]) => {
      if (this.builtinIds.has(id) || !authUrl(config.baseUrl) || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(config.api)) return;
      try {
        const resolution = await runtime.getAuth(id);
        if (!resolution) throw new Error('Provider login is missing');
        const models = await discoverCustomModels(config, resolution.auth.apiKey, runtime.getModels(), resolution.auth.headers);
        await saveCustomProvider(path, id, { ...config, models }, config);
      } catch { failures.push(id); }
    }));
    this.catalogWarning = failures.length ? `Could not refresh models for ${failures.join(', ')}. Keeping the last successful catalog.` : undefined;
  }
  async syncAccounts(runtime) {
    this.syncingAccounts ??= (async () => {
      this.accountRecords = await readProviderAccounts(this.authPath);
      const previous = new Set(this.accounts.keys());
      await loadAccountProviders(this.authPath, this.createRuntime, this.accounts);
      for (const [id, provider] of this.accounts) if (!previous.has(id)) runtime.registerNativeProvider(provider);
    })().finally(() => { this.syncingAccounts = undefined; });
    await this.syncingAccounts;
  }
}
