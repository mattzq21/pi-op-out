import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startDaemon, type TestDaemon } from './harness';

const appSettings = createRequire(import.meta.url)('../../daemon/resources/session-broker/app-settings.cjs');
let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.stop(); });

const auth = (request: any) => daemon.invoke('provider_auth', { hostId: 'local', request });
const provider = async (id: string) => (await auth({ action: 'list', refreshModels: false })).providers.find((item: any) => item.id === id);
/** Polls a login flow, as the app does, until check accepts it. */
async function flowUntil(flowId: string, check: (flow: any) => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    const flow = await auth({ action: 'poll', flowId });
    if (check(flow)) return flow;
    await Bun.sleep(100);
  }
  throw new Error('Login flow never reached the expected state');
}

test('an API key login asks for the key, stores it, and logging out removes it', async () => {
  expect(await provider('deepseek')).toMatchObject({ configured: false });
  const begun = await auth({ action: 'begin', providerId: 'deepseek', authType: 'api_key' });
  const asking = await flowUntil(begun.flowId, flow => Boolean(flow.prompt));
  expect(asking.prompt).toMatchObject({ type: 'secret' });
  await auth({ action: 'reply', flowId: begun.flowId, promptId: asking.prompt.id, answer: 'sk-test-deepseek-key' });
  expect(await flowUntil(begun.flowId, flow => flow.status !== 'pending')).toMatchObject({ status: 'complete' });
  expect(await provider('deepseek')).toMatchObject({ configured: true, storedType: 'api_key' });
  expect(JSON.stringify(JSON.parse(readFileSync(join(daemon.home, '.piop', 'auth.json'), 'utf8')))).toContain('sk-test-deepseek-key');
  await auth({ action: 'logout', providerId: 'deepseek' });
  expect(await provider('deepseek')).toMatchObject({ configured: false });
}, 60000);

test('a cancelled login stores nothing', async () => {
  const begun = await auth({ action: 'begin', providerId: 'fireworks', authType: 'api_key' });
  await flowUntil(begun.flowId, flow => Boolean(flow.prompt));
  await auth({ action: 'cancel', flowId: begun.flowId });
  expect(await flowUntil(begun.flowId, flow => flow.status !== 'pending')).toMatchObject({ status: 'cancelled' });
  expect(await provider('fireworks')).toMatchObject({ configured: false });
}, 60000);

test('a custom provider is added with its key and its models become available to chats', async () => {
  const authorizations: Array<string | undefined> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => {
    authorizations.push(request.headers.get('authorization') ?? undefined);
    return new URL(request.url).pathname === '/v1/models' ? Response.json({ object: 'list', data: [{ id: 'llama-test', object: 'model' }] }) : new Response('not found', { status: 404 });
  } });
  try {
    await auth({ action: 'create', providerId: 'local-llm', name: 'Local LLM', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', apiKey: 'local-key', noKey: false, sessionAffinity: false });
    expect(authorizations).toContain('Bearer local-key');
    expect(await provider('local-llm')).toMatchObject({ name: 'Local LLM', configured: true });
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    await daemon.invoke('start_pi', { runtimeId: 'models', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    const models = await daemon.invoke('pi_command', { runtimeId: 'models', command: { type: 'get_available_models' } });
    expect(models.models.map((model: any) => [model.provider, model.id])).toContainEqual(['local-llm', 'llama-test']);
  } finally { server.stop(true); }
}, 60000);

test('a new chat reads changed agent definitions only when it asks for a reload', async () => {
  const names = (catalog: any) => catalog.config.agents.map((agent: any) => agent.name);
  const before = await auth({ action: 'draft_catalog' });
  expect(names(before)).toContain('general');
  const { isDefault: _isDefault, ...general } = before.config.agents.find((agent: any) => agent.name === 'general');
  appSettings.write(join(daemon.home, '.piop', 'piop-define-agents', 'config.json'), JSON.stringify({ agents: [...before.config.agents, { ...general, name: 'added-on-disk' }] }));
  expect(names(await auth({ action: 'draft_catalog' }))).not.toContain('added-on-disk');
  expect(names(await auth({ action: 'draft_catalog', reload: true }))).toContain('added-on-disk');
}, 60000);
