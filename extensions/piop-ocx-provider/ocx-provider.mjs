import { readFile as ocxReadFile, stat as ocxStat } from 'node:fs/promises';
import { join as ocxJoin } from 'node:path';

export const OCX_PROVIDER_ID = 'opencodex';
const OCX_LEVELS = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const OCX_FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function ocxCount(value) { return Number.isSafeInteger(value) && value > 0 ? value : undefined; }

function ocxModel(entry) {
  if (typeof entry?.id !== 'string' || !entry.id.trim()) throw new Error('OCX returned a model without an ID');
  const capabilities = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
  const name = [entry.display_name, entry.name].find(value => typeof value === 'string' && value.trim());
  const input = Array.isArray(capabilities.input_modalities) ? capabilities.input_modalities.filter(value => value === 'text' || value === 'image') : [];
  const model = { id: entry.id, name: name ?? entry.id, reasoning: capabilities.supports_reasoning === true || entry.supports_reasoning_effort === true, input: input.includes('text') ? input : ['text'], cost: OCX_FREE };
  model.contextWindow = ocxCount(capabilities.context_length) ?? 128000;
  model.maxTokens = ocxCount(capabilities.max_output_tokens) ?? 16384;
  const efforts = new Set((Array.isArray(entry.reasoning_efforts) ? entry.reasoning_efforts : []).map(effort => effort?.value).filter(value => typeof value === 'string'));
  if (model.reasoning && efforts.size) model.thinkingLevelMap = Object.fromEntries(Object.entries(OCX_LEVELS).map(([level, value]) => [level, efforts.has(value) ? value : null]));
  return model;
}

/** Undefined when OCX is not installed for this user; throws when it is installed but cannot give its models. */
export async function ocxProviderConfig(home) {
  const root = ocxJoin(home, '.opencodex');
  try { if (!(await ocxStat(root)).isDirectory()) return undefined; } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  let port;
  try { port = JSON.parse(await ocxReadFile(ocxJoin(root, 'runtime-port.json'), 'utf8')).port; }
  catch (error) { throw new Error(error?.code === 'ENOENT' ? 'OCX is not running. Start it with ocx start.' : 'Could not read the OCX port: ' + (error?.message ?? error)); }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OCX wrote an invalid port');
  const baseUrl = 'http://127.0.0.1:' + port + '/v1';
  let response;
  try { response = await fetch(baseUrl + '/models', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }); }
  catch (error) { throw new Error('OCX is not responding at ' + baseUrl + '. Start it with ocx start.'); }
  if (!response.ok) throw new Error('OCX returned HTTP ' + response.status + ' for its models');
  const body = await response.json().catch(() => { throw new Error('OCX returned an invalid model list'); });
  if (!Array.isArray(body?.data)) throw new Error('OCX returned an invalid model list');
  const models = body.data.map(ocxModel);
  if (!models.length) throw new Error('OCX has no models');
  return { name: 'OCX', baseUrl, api: 'openai-responses', apiKey: 'not-required', authHeader: false, models };
}
