import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory, type TestDaemon } from './harness';

// Provider token endpoints answer with test tokens, so the whole login runs without real accounts.
const TOKENS = `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://auth.openai.com/api/accounts/oauth/token') return Response.json({ access_token: 'openai-test-access', refresh_token: 'openai-test-refresh', id_token: 'id', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', expires_in: 3600 });
  if (url === 'https://platform.claude.com/v1/oauth/token') return Response.json({ access_token: 'anthropic-test-access', refresh_token: 'anthropic-test-refresh', expires_in: 3600 });
  return real(input, init);
};
`;

let daemon: TestDaemon;
beforeAll(async () => {
  const mock = join(temporaryDirectory('piop-token-mock-'), 'tokens.mjs');
  writeFileSync(mock, TOKENS);
  daemon = await startDaemon({ env: { NODE_OPTIONS: '--import ' + mock } });
}, 60000);
afterAll(async () => { await daemon?.stop(); });

const auth = (request: any) => daemon.invoke('provider_auth', { hostId: 'local', request });
const provider = async (id: string) => (await auth({ action: 'list', refreshModels: false })).providers.find((item: any) => item.id === id);
const saved = (id: string) => JSON.parse(readFileSync(join(daemon.home, '.piop', 'auth.json'), 'utf8'))[id];
async function flowUntil(flowId: string, check: (flow: any) => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    const flow = await auth({ action: 'poll', flowId });
    if (check(flow)) return flow;
    await Bun.sleep(100);
  }
  throw new Error('Login flow never reached the expected state: ' + JSON.stringify(await auth({ action: 'poll', flowId })));
}
const loginUrl = (flow: any) => new URL(flow.notices.find((notice: any) => notice.type === 'auth_url').url);

test('ChatGPT login completes when the browser returns to the host', async () => {
  const begun = await auth({ action: 'begin', providerId: 'openai', authType: 'oauth' });
  const waiting = await flowUntil(begun.flowId, flow => flow.notices.some((notice: any) => notice.type === 'auth_url'));
  const url = loginUrl(waiting);
  const back = new URL(url.searchParams.get('redirect_uri')!);
  back.search = new URLSearchParams({ code: 'test-code', state: url.searchParams.get('state')!, client_id: 'test-client' }).toString();
  expect((await fetch(back)).status).toBe(200);
  expect(await flowUntil(begun.flowId, flow => flow.status !== 'pending')).toMatchObject({ status: 'complete' });
  expect(saved('openai')).toMatchObject({ type: 'oauth', access: 'openai-test-access' });
  expect(await provider('openai')).toMatchObject({ configured: true, storedType: 'oauth' });
}, 60000);

for (const host of ['127.0.0.1', '[::1]']) test(`Claude login completes when the browser returns to ${host}`, async () => {
  await auth({ action: 'logout', providerId: 'anthropic' }).catch(() => undefined);
  const begun = await auth({ action: 'begin', providerId: 'anthropic', authType: 'oauth' });
  const choosing = await flowUntil(begun.flowId, flow => flow.prompt?.type === 'select');
  await auth({ action: 'reply', flowId: begun.flowId, promptId: choosing.prompt.id, answer: 'browser' });
  const waiting = await flowUntil(begun.flowId, flow => flow.notices.some((notice: any) => notice.type === 'auth_url'));
  const url = loginUrl(waiting);
  const back = new URL(url.searchParams.get('redirect_uri')!);
  back.hostname = host;
  back.search = new URLSearchParams({ code: 'test-code', state: url.searchParams.get('state')! }).toString();
  const answer = await fetch(back).catch((error: Error) => error);
  expect(answer instanceof Error ? answer.message : answer.status).toBe(200);
  expect(await flowUntil(begun.flowId, flow => flow.status !== 'pending')).toMatchObject({ status: 'complete' });
  expect(saved('anthropic')).toMatchObject({ type: 'oauth', access: 'anthropic-test-access' });
}, 60000);

test('Claude copy-code login completes with the pasted code', async () => {
  await auth({ action: 'logout', providerId: 'anthropic' }).catch(() => undefined);
  const begun = await auth({ action: 'begin', providerId: 'anthropic', authType: 'oauth' });
  const choosing = await flowUntil(begun.flowId, flow => flow.prompt?.type === 'select');
  await auth({ action: 'reply', flowId: begun.flowId, promptId: choosing.prompt.id, answer: 'copy_code' });
  const pasting = await flowUntil(begun.flowId, flow => flow.prompt?.type === 'manual_code');
  const state = loginUrl(pasting).searchParams.get('state');
  await auth({ action: 'reply', flowId: begun.flowId, promptId: pasting.prompt.id, answer: 'test-code#' + state });
  expect(await flowUntil(begun.flowId, flow => flow.status !== 'pending')).toMatchObject({ status: 'complete' });
  expect(saved('anthropic')).toMatchObject({ type: 'oauth', access: 'anthropic-test-access' });
}, 60000);

test('OpenCode login saves the API key', async () => {
  const begun = await auth({ action: 'begin', providerId: 'opencode', authType: 'api_key' });
  const asking = await flowUntil(begun.flowId, flow => Boolean(flow.prompt));
  expect(asking.prompt).toMatchObject({ type: 'secret' });
  await auth({ action: 'reply', flowId: begun.flowId, promptId: asking.prompt.id, answer: 'sk-test-opencode' });
  expect(await flowUntil(begun.flowId, flow => flow.status !== 'pending')).toMatchObject({ status: 'complete' });
  expect(saved('opencode')).toMatchObject({ type: 'api_key', key: 'sk-test-opencode' });
  expect(await provider('opencode')).toMatchObject({ configured: true, storedType: 'api_key' });
}, 60000);
