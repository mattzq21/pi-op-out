export const FAST_CATALOG_CLIENT_VERSION = '0.159.3';

function fastCatalogUrl(model, resolution) {
  const url = new URL(resolution.auth.baseUrl ?? model.baseUrl);
  let path = url.pathname.replace(/\/+$/, '').replace(/\/responses$/, '');

  if (model.api === 'openai-codex-responses') {
    if (!path.endsWith('/codex')) path += '/codex';
  }

  url.pathname = `${path}/models`;
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

  if (auth.apiKey) headers.set('Authorization', `Bearer ${auth.apiKey}`);

  if (model.api === 'openai-codex-responses') {
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

function fastCatalogEntry(entry, provider) {
  const id = fastCatalogField(entry, ['slug', 'id', 'model']);
  const tiers = fastCatalogField(entry, ['service_tiers', 'serviceTiers']);
  const speeds = fastCatalogField(entry, ['additional_speed_tiers', 'additionalSpeedTiers']);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the remote catalog identifier before exposing it to clients.
  if (typeof id !== 'string') return [];

  if (!Array.isArray(tiers) && !Array.isArray(speeds)) return [];
  const priority = Array.isArray(tiers) && tiers.some(tier => tier?.id === 'priority');
  const fast = Array.isArray(speeds) && speeds.includes('fast');

  return [{ provider, model: id, supported: priority || fast }];
}

async function fetchFastCatalog(runtime, model) {
  try {
    const resolution = await runtime.getAuth(model);

    if (!resolution) return [];

    const response = await fetch(fastCatalogUrl(model, resolution), {
      headers: fastCatalogHeaders(model, resolution.auth), signal: AbortSignal.timeout(5_000), redirect: 'error',
    });

    if (!response.ok) return [];
    const body = await response.json();
    const catalog = body.models ?? body.data;

    return Array.isArray(catalog) ? catalog.flatMap(entry => fastCatalogEntry(entry, model.provider)) : [];
  } catch { return []; }
}

export async function discoverFastCapabilities(runtime) {
  const groups = new Map();

  for (const model of runtime.getModels()) {
    if (!['openai', 'openai-codex'].includes(model.provider)) continue;
    groups.set(`${model.provider}:${model.baseUrl}:${model.api}`, model);
  }

  const results = await Promise.all([...groups.values()].map(model => fetchFastCatalog(runtime, model)));

  return results.flat();
}
