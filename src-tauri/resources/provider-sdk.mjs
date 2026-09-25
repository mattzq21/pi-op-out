import { realpath, readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// This adapter only invokes Pi's JavaScript provider SDK. Rust owns the service
// protocol, login flows, configuration files, and all agent session processes.
const emit = (packet) => process.stdout.write(JSON.stringify(packet) + '\n');
const logins = new Map();
const cancelled = new Set();
const accounts = new Map();
let initializing, syncing;

async function resolveExecutable() {
  const executable = process.argv[1] || 'pi';
  const expanded = executable.startsWith('~/') ? join(homedir(), executable.slice(2)) : executable;
  const candidates = /[/\\]/.test(expanded) ? [resolve(expanded)] : (process.env.PATH || '').split(delimiter).map((directory) => join(directory, expanded));
  let entry;
  for (const candidate of candidates) {
    try { entry = await realpath(candidate); break; } catch { /* Try the next PATH entry. */ }
  }
  if (!entry) throw new Error('Pi is unavailable on this host. Check its Pi executable setting.');
  return entry;
}

async function loadRuntime() {
  const entry = await resolveExecutable();
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    let metadata;
    try { metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { /* Not a package root. */ }
    if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(metadata?.name)) {
      const sdk = await import(pathToFileURL(join(directory, 'dist/core/model-runtime.js')).href).catch(() => undefined);
      if (!sdk?.ModelRuntime?.create) break;
      const config = await import(pathToFileURL(join(directory, 'dist/config.js')).href);
      const builtin = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false }).catch(() => { throw new Error('Could not load provider configuration on this host. Check Pi configuration and file permissions.'); });
      return { runtime, authPath: config.getAuthPath(), builtinIds: builtin.getProviders().map((provider) => provider.id), createRuntime: () => sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }) };
    }
    directory = dirname(directory);
  }
  throw new Error('Provider login requires a Pi Node installation with ModelRuntime support on this host. Update Pi and try again.');
}

function runtime() {
  initializing ??= loadRuntime().catch((error) => { initializing = undefined; throw error; });
  return initializing;
}

async function syncAccounts(loaded) {
  syncing ??= (async () => {
    const previous = new Map(accounts);
    await loadAccountProviders(loaded.authPath, loaded.createRuntime, accounts);
    for (const [id, provider] of accounts) if (previous.get(id) !== provider) loaded.runtime.registerNativeProvider(provider);
  })().finally(() => { syncing = undefined; });
  await syncing;
}

function providerMetadata(runtime, provider) {
  const methods = [];
  if (provider.auth.oauth) methods.push({ type: 'oauth', name: provider.auth.oauth.loginLabel || provider.auth.oauth.name, interactive: true, login: Boolean(provider.auth.oauth.login) });
  if (provider.auth.apiKey) methods.push({ type: 'api_key', name: provider.auth.apiKey.name, interactive: Boolean(provider.auth.apiKey.login), login: Boolean(provider.auth.apiKey.login) });
  const status = runtime.getProviderAuthStatus(provider.id);
  return { id: provider.id, name: provider.name, configured: status.configured, source: status.label ?? status.source, methods };
}

function prompt(flowId, login, request) {
  if (login.key !== undefined) return Promise.resolve(login.key);
  const signals = [login.controller.signal, request.signal].filter(Boolean);
  if (signals.some((signal) => signal.aborted)) return Promise.reject(new Error('Login cancelled'));
  return new Promise((resolve, reject) => {
    const promptId = randomUUID();
    const finish = (answer) => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
      if (login.promptId === promptId) { login.answer = undefined; login.promptId = undefined; }
      emit({ event: 'prompt_resolved', flowId, promptId });
      if (answer === null) reject(new Error('Login cancelled')); else resolve(answer);
    };
    const abort = () => finish(null);
    login.promptId = promptId; login.answer = finish;
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    emit({ event: 'prompt', flowId, promptId, request: { type: request.type, message: request.message, placeholder: request.placeholder, options: request.options } });
  });
}

async function login(packet) {
  const state = { controller: new AbortController(), key: packet.key };
  logins.set(packet.flowId, state);
  if (cancelled.delete(packet.flowId)) state.controller.abort();
  try {
    const loaded = await runtime();
    await syncAccounts(loaded);
    await loaded.runtime.login(packet.providerId, packet.authType, {
      signal: state.controller.signal,
      prompt: (request) => prompt(packet.flowId, state, request),
      notify: (notice) => { if (!state.controller.signal.aborted) emit({ event: 'notice', flowId: packet.flowId, notice }); },
    });
    if (accounts.has(packet.providerId)) await loaded.runtime.refresh({ providers: [packet.providerId], allowNetwork: true, signal: state.controller.signal });
    return { status: 'complete' };
  } catch (error) {
    return loginFailure(error, state.controller.signal);
  } finally { state.answer?.(null); logins.delete(packet.flowId); }
}

function loginFailure(error, signal) {
  if (error?.operation === 'login' && error?.credential) return { status: 'complete' };
  if (signal.aborted) return { status: 'cancelled' };
  return { status: 'failed', error: error instanceof Error && error.message.trim() ? error.message.slice(0, 400) : 'Provider login failed. Check your details and try again.' };
}

function cancelLogin(packet) {
  const login = logins.get(packet.flowId);
  if (login) login.controller.abort();
  else { cancelled.add(packet.flowId); if (cancelled.size > 1024) cancelled.delete(cancelled.values().next().value); }
}

function answerLogin(packet) {
  const state = logins.get(packet.flowId);
  if (!state?.answer || state.promptId !== packet.promptId) throw new Error('This login prompt has expired');
  state.answer(packet.answer);
}

async function handle(packet) {
  if (packet.method === 'login') return login(packet);
  if (packet.method === 'cancel') return cancelLogin(packet);
  if (packet.method === 'answer') return answerLogin(packet);
  const loaded = await runtime();
  if (packet.method === 'initialize') return { authPath: loaded.authPath, builtinIds: loaded.builtinIds };
  await syncAccounts(loaded);
  if (packet.method === 'inspect') {
    await loaded.runtime.refresh({ allowNetwork: false }).catch(() => { throw new Error('Could not refresh providers on this host. Check Pi configuration.'); });
    const credentials = await loaded.runtime.listCredentials().catch(() => { throw new Error('Could not read saved provider status on this host.'); });
    return { providers: loaded.runtime.getProviders().map((provider) => providerMetadata(loaded.runtime, provider)), models: loaded.runtime.getModels(), credentials: credentials.map(({ providerId, type }) => ({ providerId, type })) };
  }
  if (packet.method === 'logout') { await loaded.runtime.logout(packet.providerId); return; }
  if (packet.method === 'auth') {
    const resolution = await loaded.runtime.getAuth(packet.providerId);
    return resolution ? { apiKey: resolution.auth.apiKey, headers: resolution.auth.headers } : null;
  }
  throw new Error('Unknown provider SDK operation');
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let packet;
  try { packet = JSON.parse(line); } catch { return; }
  Promise.resolve().then(() => handle(packet)).then(
    (data) => emit({ id: packet.id, data: data ?? null }),
    (error) => emit({ id: packet.id, error: error instanceof Error ? error.message : String(error) }),
  );
});
input.on('close', () => { for (const login of logins.values()) login.controller.abort(); process.exit(0); });
process.on('SIGTERM', () => { for (const login of logins.values()) login.controller.abort(); process.exit(0); });
