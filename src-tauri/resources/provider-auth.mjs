import { realpath as authRealpath, readFile as authReadFile, stat as authStat } from 'node:fs/promises';
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
      const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false }).catch(() => { throw new Error('Could not load provider configuration on this host. Check Pi configuration and file permissions.'); });
      return { runtime, authPath: config.getAuthPath() };
    }
    directory = authDirname(directory);
  }
  throw new Error('Provider login requires a Pi Node installation with ModelRuntime support on this host. Update Pi and try again.');
}

function authText(value) { return typeof value === 'string' ? value.slice(0, 8192) : ''; }
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
    this.initializing ??= providerAuthRuntime(this.executable).then(({ runtime, authPath }) => {
      this.authPath = authPath;
      return runtime;
    }).catch((error) => { this.initializing = undefined; throw error; });
    return this.initializing;
  }

  async checkForChanges() {
    this.checkingCredentials ??= (async () => {
      await this.runtime();
      let revision;
      try {
        const stat = await authStat(this.authPath, { bigint: true });
        revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
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
    return { flowId: flow.id, providerId: flow.providerId, status: flow.status, notices: flow.notices, prompt: flow.prompt, error: flow.error };
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

  async listing() {
    const runtime = await this.runtime();
    await runtime.refresh({ allowNetwork: false }).catch(() => { throw new Error('Could not refresh providers on this host. Check Pi configuration.'); });
    const credentials = await runtime.listCredentials().catch(() => { throw new Error('Could not read saved provider status on this host.'); });
    const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
    return { providers: runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const methods = [];
      if (provider.auth.oauth) methods.push({ type: 'oauth', name: provider.auth.oauth.loginLabel || provider.auth.oauth.name, interactive: true });
      if (provider.auth.apiKey) methods.push({ type: 'api_key', name: provider.auth.apiKey.name, interactive: Boolean(provider.auth.apiKey.login) });
      return { id: provider.id, name: provider.name, configured: status.configured, source: status.label ?? status.source, storedType: stored.get(provider.id), methods };
    }).filter((provider) => provider.methods.length).sort((left, right) => left.name.localeCompare(right.name)) };
  }

  async begin(owner, request) {
    const runtime = await this.runtime();
    const provider = runtime.getProvider(request.providerId);
    if (!provider) throw new Error('Provider is unavailable on this host');
    if (!['oauth', 'api_key'].includes(request.authType) || !provider.auth[request.authType === 'oauth' ? 'oauth' : 'apiKey']?.login) throw new Error('This provider uses credentials configured on the host');
    this.prune();
    if (this.flows.size >= 32) throw new Error('Too many login attempts. Try again later.');
    if (this.busy.has(provider.id)) throw new Error('A credential operation is already running for this provider');
    const flow = { id: authUuid(), owner, providerId: provider.id, controller: new AbortController(), status: 'pending', notices: [], createdAt: Date.now() };
    this.flows.set(flow.id, flow);
    this.busy.add(provider.id);
    const timer = setTimeout(() => this.cancel(flow), 10 * 60_000);
    timer.unref();
    void this.login(runtime, flow, request.authType).finally(() => { clearTimeout(timer); this.busy.delete(provider.id); });
    return this.snapshot(flow);
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
    if (request.action === 'list') return this.listing();
    if (request.action === 'begin') return this.begin(owner, request);
    if (request.action === 'logout') return this.logout(request.providerId);
    const flow = this.ownedFlow(owner, request.flowId);
    if (request.action === 'poll') return this.snapshot(flow);
    if (request.action === 'reply') return this.reply(flow, request);
    if (request.action === 'cancel') { this.cancel(flow); return this.snapshot(flow); }
    throw new Error('Unknown provider authentication operation');
  }
}
