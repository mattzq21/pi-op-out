import { createHash as fastModelHash } from 'node:crypto';

const FAST_CATALOG_CLIENT_VERSION = '0.159.3';
const FAST_MODEL_PROVIDERS = new Set(['openai', 'openai-codex']);

function fastCatalogUrl(model, auth) {
  const url = new URL(auth.baseUrl ?? model.baseUrl);
  let path = url.pathname.replace(/\/+$/, '').replace(/\/responses$/, '');

  if (model.api === 'openai-codex-responses' && !path.endsWith('/codex')) path += '/codex';
  url.pathname = path + '/models';
  url.searchParams.set('client_version', FAST_CATALOG_CLIENT_VERSION);

  return url;
}

function fastAccountId(key) {
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));

    return claims['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch { return undefined; }
}

function fastCatalogHeaders(model, auth) {
  const headers = new Headers(model.headers);

  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) headers.delete(key); else headers.set(key, value);
  }

  if (auth.apiKey) headers.set('Authorization', 'Bearer ' + auth.apiKey);

  if (model.api === 'openai-codex-responses' && auth.apiKey) {
    headers.set('originator', 'pi');
    const account = fastAccountId(auth.apiKey);

    if (account) headers.set('chatgpt-account-id', account);
  }

  headers.set('Accept', 'application/json');

  return headers;
}

function fastCatalogField(entry, keys) {
  return keys.map(key => entry?.[key]).find(value => value != null);
}

/** Returns true or false when the entry states its speed tiers, and undefined when it does not. */
function fastSupport(entry) {
  const tiers = fastCatalogField(entry, ['service_tiers', 'serviceTiers']);
  const speeds = fastCatalogField(entry, ['additional_speed_tiers', 'additionalSpeedTiers']);

  if (!Array.isArray(tiers) && !Array.isArray(speeds)) return undefined;

  return (Array.isArray(tiers) && tiers.some(tier => tier?.id === 'priority')) || (Array.isArray(speeds) && speeds.includes('fast'));
}

async function fetchFastCatalog(model, auth) {
  const response = await fetch(fastCatalogUrl(model, auth), { headers: fastCatalogHeaders(model, auth), signal: AbortSignal.timeout(5_000), redirect: 'error' });

  if (!response.ok) throw new Error('model list request failed with HTTP ' + response.status);
  const body = await response.json();
  const catalog = body?.models ?? body?.data;

  if (!Array.isArray(catalog)) throw new Error('model list has an invalid format');
  const support = new Map();

  for (const entry of catalog) {
    const id = fastCatalogField(entry, ['slug', 'id', 'model']);
    const supported = fastSupport(entry);

    if (typeof id === 'string' && supported !== undefined) support.set(id, supported);
  }

  return support;
}

/** The login's account: the ChatGPT account id when the token has one, else a hash of the key. Stays the same when a token refreshes. */
function fastLoginIdentity(auth) {
  if (!auth.apiKey) return null;

  return fastAccountId(auth.apiKey) ?? fastModelHash('sha256').update(auth.apiKey).digest('hex');
}

/** One provider's models grouped by endpoint, with the login that each endpoint uses. Rejects when a login cannot be read. */
async function fastProviderState(runtime, provider) {
  const groups = new Map();

  for (const model of runtime.getModels(provider)) {
    const key = JSON.stringify([model.baseUrl, model.api]);
    groups.set(key, [...groups.get(key) ?? [], model]);
  }

  const endpoints = await Promise.all([...groups.values()].map(async models => ({ models, auth: (await runtime.getAuth(models[0]))?.auth })));
  const identity = endpoints.map(({ models, auth }) => [models[0].baseUrl, models[0].api, auth ? [fastLoginIdentity(auth), ...[...fastCatalogHeaders(models[0], auth).entries()].filter(([key]) => key !== 'authorization'), String(fastCatalogUrl(models[0], auth))] : null]);
  const context = fastModelHash('sha256').update(JSON.stringify(identity)).digest('hex');

  return { endpoints, context };
}

async function scanFastProvider(runtime, provider) {
  let state;

  try {
    state = await fastProviderState(runtime, provider);
  } catch (error) {
    return { provider, status: 'error', message: 'Could not read the ' + provider + ' login: ' + (error instanceof Error ? error.message : String(error)) };
  }
  const { endpoints, context } = state;

  try {
    const lists = await Promise.all(endpoints.map(async ({ models, auth }) => {
      if (!auth) return [];
      const support = await fetchFastCatalog(models[0], auth);

      return models.filter(model => support.get(model.id) ?? fastSupport(model)).map(model => model.id);
    }));
    const after = await fastProviderState(runtime, provider);

    if (after.context !== context) return { provider, status: 'error', message: 'The ' + provider + ' login or configuration changed during the fast model scan', context: after.context };

    return { provider, status: 'ok', supportedModelIds: [...new Set(lists.flat())], context };
  } catch (error) {
    return { provider, status: 'error', message: 'Could not load the ' + provider + ' fast model list: ' + (error instanceof Error ? error.message : String(error)), context };
  }
}

/**
 * Finds the models that accept fast mode, with one host's model runtime and logins.
 * Owns the discovery rules and provider requests; the host owns scheduling and saved results.
 * Each result also has context: a fingerprint of the provider's endpoints and login,
 * so the host can keep results apart per account and configuration.
 */
export function createFastModelDiscovery(runtime) {
  return {
    async scan(provider) {
      await runtime.refresh({ allowNetwork: false });
      const registered = runtime.getProviders().map(item => item.id);

      if (provider !== undefined && !registered.includes(provider)) return [{ provider, status: 'error', message: 'Unknown provider ' + provider, context: '' }];
      const providers = (provider === undefined ? registered : [provider]).filter(id => FAST_MODEL_PROVIDERS.has(id));

      return Promise.all(providers.map(id => scanFastProvider(runtime, id)));
    },
  };
}
