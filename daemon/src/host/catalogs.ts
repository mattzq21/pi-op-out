import { flag, text, array } from './json';

const DISCOVERY_ERROR = 'Could not discover models. Check the API URL and connectivity from the selected host.';

export function authUrl(value: any): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

export function authText(value: any): string {
  return typeof value === 'string' ? Array.from(value).slice(0, 8192).join('') : '';
}

function validProviderId(id: string): boolean {
  return id.length > 0 && id.length <= 80 && /^[a-z0-9][a-z0-9_-]*$/.test(id);
}

export function supportedApi(config: any): boolean {
  return ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(config?.api);
}

export function customConfig(request: any): any {
  const id = text(request, 'providerId');
  if (!validProviderId(id)) throw new Error('Use a unique provider ID containing lowercase letters, numbers, hyphens or underscores');
  if (!supportedApi(request)) throw new Error('Choose a supported API format');
  const raw = authUrl(request?.baseUrl);
  const url = raw ? new URL(raw) : null;
  if (!url || url.username || url.password) throw new Error('Enter an HTTP or HTTPS API URL without embedded credentials');
  const name = authText(request?.name);
  const config: any = { name: name.trim() ? name.trim() : id, baseUrl: url.toString().replace(/\/+$/, ''), api: request.api };
  if (flag(request, 'noKey')) { config.apiKey = 'not-required'; config.authHeader = false; }
  if (flag(request, 'sessionAffinity')) config.compat = { sessionAffinityFormat: 'openai', sendSessionAffinityHeaders: true };
  return config;
}

function headersFor(config: any, key: string | null | undefined, extra: any): Headers {
  const headers = new Headers();
  const insert = (name: string, value: string) => {
    try { headers.set(name, value); } catch { throw new Error('Invalid provider authentication header'); }
  };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) for (const [name, value] of Object.entries(extra)) if (typeof value === 'string') insert(name, value);
  insert('accept', 'application/json');
  if (key) insert('authorization', 'Bearer ' + key);
  if (config?.api === 'anthropic-messages') {
    insert('anthropic-version', '2023-06-01');
    if (key) insert('x-api-key', key);
  }
  return headers;
}

async function catalogPage(url: URL, headers: Headers, signal: AbortSignal): Promise<any> {
  let response: Response;
  try { response = await fetch(url, { headers, redirect: 'manual', signal }); } catch { throw new Error(DISCOVERY_ERROR); }
  if (response.status < 200 || response.status > 299) {
    try { await response.body?.cancel(); } catch {}
    throw new Error('Model discovery returned HTTP ' + response.status + '. Check the API URL and key.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new RangeError('Model catalog is too large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof RangeError) throw new Error(error.message);
    throw new Error(DISCOVERY_ERROR);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Models endpoint did not return valid JSON'); }
}

function validCount(value: any): boolean { return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 9_007_199_254_740_991; }

export function discoveredModel(entry: any, known: any[]): any {
  const id = entry?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('The models endpoint returned an invalid model ID');
  const name = authText(typeof entry.name === 'string' && entry.name ? entry.name : entry.display_name);
  const model: any = { id, name: name || id };
  const baseline = known.find(item => item?.id === id);
  if (baseline) for (const field of ['reasoning', 'input', 'contextWindow', 'maxTokens']) if (Object.hasOwn(baseline, field)) model[field] = baseline[field];
  if (typeof entry.reasoning === 'boolean') model.reasoning = entry.reasoning;
  if (Array.isArray(entry.input) && entry.input.every((item: any) => item === 'text' || item === 'image')) model.input = entry.input;
  for (const [field, aliases] of [['contextWindow', ['contextWindow', 'context_length', 'context_window']], ['maxTokens', ['maxTokens', 'max_output_tokens', 'max_tokens']]] as const) {
    const value = aliases.map(alias => entry[alias]).find(value => value !== undefined && value !== null);
    if (validCount(value)) model[field] = value;
  }
  return model;
}

export async function discover(config: any, key: string | null | undefined, known: any[], extraHeaders: any): Promise<any[]> {
  let url: URL;
  try { url = new URL(text(config, 'baseUrl')); } catch { throw new Error('Enter an HTTP or HTTPS API URL without embedded credentials'); }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/models';
  const headers = headersFor(config, key, extraHeaders);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    const models = new Map<string, any>();
    for (let page = 0; page < 50; page += 1) {
      const body = await catalogPage(url, headers, controller.signal);
      const entries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
      if (!entries) throw new Error('Expected a models endpoint returning a data array');
      for (const entry of entries) { const model = discoveredModel(entry, known); models.set(model.id, model); }
      if (!flag(body, 'has_more')) {
        if (!models.size) throw new Error('The provider returned no models');
        return [...models.keys()].sort().map(id => models.get(id));
      }
      const after = body?.last_id;
      if (typeof after !== 'string' || url.searchParams.getAll('after_id').includes(after)) throw new Error('Invalid model catalog pagination');
      url.searchParams.delete('after_id');
      url.searchParams.append('after_id', after);
    }
    throw new Error('Model catalog exceeds the pagination limit');
  } catch (error) {
    if (timedOut) throw new Error(DISCOVERY_ERROR);
    throw error;
  } finally { clearTimeout(timer); }
}

export function mergeModels(config: any, discovered: any[]): any[] {
  const saved = array(config, 'models');
  const ids = new Set(discovered.map(model => text(model, 'id')));
  const models = discovered.map(model => {
    const original = saved.find(item => item?.id === model.id);
    return original && typeof original === 'object' && !Array.isArray(original) ? { ...model, ...original } : model;
  });
  models.push(...saved.filter(model => !ids.has(text(model, 'id'))));
  return models;
}
