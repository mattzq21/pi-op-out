import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory, type TestDaemon } from './harness';

let daemon: TestDaemon;
let ocx: ReturnType<typeof Bun.serve>;
let catalog: { status: number; body: unknown };

const efforts = (...values: string[]) => values.map(value => ({ value, label: value }));

beforeAll(async () => {
  catalog = { status: 200, body: { object: 'list', data: [
    { id: 'gpt-test', object: 'model', reasoning_efforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), capabilities: { context_length: 872000, max_output_tokens: 128000, input_modalities: ['text', 'image'], supports_reasoning: true } },
    { id: 'ocproxy-responses/plain', object: 'model', capabilities: { input_modalities: ['text'] } },
  ] } };
  ocx = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => new URL(request.url).pathname === '/v1/models' ? Response.json(catalog.body, { status: catalog.status }) : new Response('not found', { status: 404 }) });
  const home = temporaryDirectory('piop-home-');
  mkdirSync(join(home, '.opencodex'), { recursive: true });
  writeFileSync(join(home, '.opencodex/runtime-port.json'), JSON.stringify({ pid: 1, port: ocx.port }));
  daemon = await startDaemon({ home });
}, 60_000);
afterAll(async () => { await daemon?.stop(); ocx?.stop(true); });

const auth = (request: any) => daemon.invoke('provider_auth', { hostId: 'local', request });

test('OCX is a built-in provider whose models chats can use without a key', async () => {
  const listing = await auth({ action: 'list', refreshModels: false });
  expect(listing.providers.find((item: any) => item.id === 'opencodex')).toEqual({ id: 'opencodex', name: 'OCX', configured: true, source: 'built in', methods: [], builtin: true });
  expect(await daemon.failure('provider_auth', { hostId: 'local', request: { action: 'remove', providerId: 'opencodex' } })).toContain('Only custom providers');
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  await daemon.invoke('start_pi', { runtimeId: 'ocx', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
  const models = (await daemon.invoke('pi_command', { runtimeId: 'ocx', command: { type: 'get_available_models' } })).models.filter((model: any) => model.provider === 'opencodex');
  expect(models.map((model: any) => [model.id, model.contextWindow, model.maxTokens, model.input, model.reasoning, model.thinkingLevelMap])).toEqual([
    ['gpt-test', 872000, 128000, ['text', 'image'], true, { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }],
    ['ocproxy-responses/plain', 128000, 16384, ['text'], false, undefined],
  ]);
  expect(models[0]).toMatchObject({ api: 'openai-responses', baseUrl: `http://127.0.0.1:${ocx.port}/v1` });
}, 60_000);

test('when OCX cannot give its models, the provider list says why and keeps the last models', async () => {
  catalog.status = 503;
  const listing = await auth({ action: 'list', refreshModels: false });
  expect(listing.warning).toContain('opencodex: OCX returned HTTP 503 for its models');
  expect(listing.providers.some((item: any) => item.id === 'opencodex')).toBe(true);
  catalog.status = 200;
  expect((await auth({ action: 'list', refreshModels: false })).warning ?? '').not.toContain('opencodex');
}, 60_000);
