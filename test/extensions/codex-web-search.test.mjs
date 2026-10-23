import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'piop-web-search-'));
const outfile = join(dir, 'extension.mjs');
await build({ entryPoints: ['extensions/piop-codex-web-search/index.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{ name: 'pi-ai', setup(api) { api.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: 'pi-ai', namespace: 'sdk' })); api.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({ contents: 'export { Type } from "typebox";', resolveDir: process.cwd() })); } }] });
const { default: register } = await import(pathToFileURL(outfile));

/** The Codex endpoint. reply decides each answer; requests keeps what the tool sent. */
const requests = [];
let reply = () => ({ status: 500, body: 'no reply set' });
let baseUrl;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    const { status = 200, body: text } = reply();
    response.writeHead(status, { 'content-type': 'text/event-stream' }).end(text);
  });
});
before(() => new Promise(resolve => server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}/backend-api`; resolve(); })));
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const token = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-7' } })).toString('base64url'), 'sig'].join('.');
const codex = id => ({ provider: 'openai-codex', api: 'openai-codex-responses', id, baseUrl });
const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

function webSearch({ models = [codex('gpt-5.4')], current = models[0], auth = () => ({ ok: true, apiKey: token }) } = {}) {
  let tool;
  register({ registerTool: definition => { tool = definition; } });
  const ctx = { model: current, modelRegistry: { getAll: () => models, getApiKeyAndHeaders: async model => auth(model) } };
  return params => tool.execute('call-1', params, undefined, undefined, ctx);
}

const searched = { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://docs.example.org/a?utm_source=openai', title: 'Docs' }, { url: 'javascript:alert(1)' }] } };
const answer = (text, ...citations) => ({ type: 'message', content: [{ type: 'output_text', text, annotations: citations.map(([url, title]) => ({ type: 'url_citation', url, title })) }] });

test('a streamed search returns the answer with each source once, without OpenAI tracking', async () => {
  reply = () => ({ body: sse([
    { type: 'response.output_item.done', item: searched },
    { type: 'response.output_item.done', item: answer('Pi 1.1 is out.', ['https://docs.example.org/a?utm_source=openai', 'Pi docs'], ['https://news.example.com/pi', 'Pi news']) },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]) });
  const result = await webSearch()({ query: '  pi release  ', domains: ['https://Docs.Example.org/path', 'docs.example.org'] });
  assert.equal(result.content[0].text, 'Pi 1.1 is out.\n\nSources:\n1. Pi docs: https://docs.example.org/a\n2. Pi news: https://news.example.com/pi');
  const sent = requests.at(-1);
  assert.equal(sent.url, '/backend-api/codex/responses');
  assert.equal(sent.headers['chatgpt-account-id'], 'acct-7');
  assert.equal(sent.body.input[0].content[0].text, 'pi release');
  assert.deepEqual(sent.body.tools, [{ type: 'web_search', filters: { allowed_domains: ['docs.example.org'] } }]);
});

test('failed searches say why and never show the login token', async () => {
  const search = webSearch();
  const failure = () => search({ query: 'q' }).then(() => 'succeeded', error => error.message);
  reply = () => ({ status: 401, body: 'bad token ' + token });
  assert.equal(await failure(), 'Codex web search HTTP 401: bad token [redacted]');
  reply = () => ({ body: sse([{ type: 'response.completed', response: { status: 'completed', output: [answer('From memory.')] } }]) });
  assert.equal(await failure(), 'Codex returned an answer without performing a web search.');
  reply = () => ({ body: sse([{ type: 'response.failed', response: { error: { message: 'Rate limit reached' } } }]) });
  assert.equal(await failure(), 'Rate limit reached');
  reply = () => ({ body: sse([{ type: 'response.output_item.done', item: searched }]) });
  assert.equal(await failure(), 'Codex web search stream ended before completion. Try the search again.');
  assert.match(await search({ query: 'q', domains: ['not a domain'] }).then(() => '', error => error.message), /^Invalid search domain: not a domain$/);
});

test('the search uses a fast, signed-in Codex model, preferring the one in use', async () => {
  reply = () => ({ body: sse([{ type: 'response.completed', response: { status: 'completed', output: [searched, answer('ok')] } }]) });
  const usedModel = async options => (await webSearch(options)({ query: 'q' })).details.model;
  const models = [codex('gpt-5.2'), codex('gpt-5.4-pro'), codex('gpt-5.3-mini'), codex('gpt-5.4')];
  assert.equal(await usedModel({ models, current: codex('gpt-5.3-mini') }), 'gpt-5.3-mini');
  assert.equal(await usedModel({ models, current: codex('gpt-5.4-pro') }), 'gpt-5.4');
  assert.equal(await usedModel({ models, current: { provider: 'anthropic', api: 'anthropic-messages', id: 'claude' } }), 'gpt-5.4');
  assert.equal(await usedModel({ models, auth: model => model.id === 'gpt-5.2' ? { ok: true, apiKey: token } : { ok: false } }), 'gpt-5.2');
  assert.equal(await webSearch({ models, auth: () => ({ ok: false }) })({ query: 'q' }).then(() => '', error => error.message),
    'Codex web search needs an authenticated openai-codex account. Use Pi /login on this host.');
});
