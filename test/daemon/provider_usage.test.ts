import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory, type TestDaemon } from './harness';

/*
 * The daemon asks https://opencode.ai/zen/go/v1/usage for OpenCode Go usage. The test daemon reaches it through an
 * HTTPS proxy in this process, which sends the connection to a local TLS server with a certificate for opencode.ai
 * that only the test daemon trusts. The server answers with the body the test sets.
 */
let daemon: TestDaemon;
let gateway: ReturnType<typeof Bun.serve>;
let proxy: Server;
let reply: { status: number; body: string } = { status: 200, body: '{}' };
const requests: Array<{ url: string; authorization: string | null }> = [];

beforeAll(async () => {
  const certificates = temporaryDirectory('piop-opencode-tls-');
  const key = join(certificates, 'key.pem'); const cert = join(certificates, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=opencode.ai', '-addext', 'subjectAltName=DNS:opencode.ai'], { stdio: 'ignore' });
  gateway = Bun.serve({
    port: 0, hostname: '127.0.0.1', tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') },
    fetch(request) {
      requests.push({ url: request.url, authorization: request.headers.get('authorization') });
      return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
  });
  proxy = createServer(client => {
    client.once('data', head => {
      const target = /^CONNECT ([^ ]+) /.exec(head.toString('latin1'))?.[1];
      if (target !== 'opencode.ai:443') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const upstream = connect(gateway.port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.pipe(upstream); upstream.pipe(client); });
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = 'http://127.0.0.1:' + (proxy.address() as any).port;
  const home = temporaryDirectory('piop-home-');
  // Pi keeps API keys in auth.json of its agent directory, which is the piop profile.
  mkdirSync(join(home, '.piop'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.piop/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'test-opencode-key' } }), { mode: 0o600 });
  daemon = await startDaemon({ home, env: { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NODE_EXTRA_CA_CERTS: cert } });
}, 60_000);
afterAll(async () => { await daemon?.stop(); gateway?.stop(true); proxy?.close(); });

test('OpenCode Go usage reports each window with its status, remaining percent and reset time', async () => {
  reply = { status: 200, body: JSON.stringify({ usage: {
    rolling: { status: 'ok', percent: 26.7, resetsAt: '2026-09-17T16:00:00.000Z' },
    weekly: { status: 'ok', percent: 55.4, resetsAt: '2026-09-21T00:00:00Z' },
    monthly: { status: 'rate-limited', percent: 101, resetsAt: '2026-09-30T00:00:00.000Z' },
  } }) };
  expect(await daemon.invoke('opencode_go_usage')).toEqual({
    rolling: { status: 'ok', remainingPercent: 73, resetAt: 1789660800 },
    weekly: { status: 'ok', remainingPercent: 45, resetAt: 1789948800 },
    monthly: { status: 'rate-limited', remainingPercent: 0, resetAt: 1790726400 },
  });
  expect(requests.at(-1)).toEqual({ url: expect.stringContaining('/zen/go/v1/usage'), authorization: 'Bearer test-opencode-key' });
}, 60_000);

test('OpenCode Go usage without all three windows is unavailable, and a gateway error passes on its message', async () => {
  for (const body of [{ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }, { usage: { rolling: { status: 'ok', percent: 50 } } }, {}]) {
    reply = { status: 200, body: JSON.stringify(body) };
    expect(await daemon.failure('opencode_go_usage'), JSON.stringify(body)).toBe('OpenCode Go usage is unavailable');
  }
  reply = { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }) };
  expect(await daemon.failure('opencode_go_usage')).toBe('OpenCode Go usage is unavailable: Unauthorized');
}, 60_000);

test('reset times are read only from UTC ISO 8601 timestamps, with or without fractions', async () => {
  const cases: Array<[string, number | undefined]> = [
    ['2026-09-17T00:00:00.000Z', 1789603200], ['2026-09-17T11:39:50Z', 1789645190], ['2000-02-29T23:59:59Z', 951868799],
    ['2026-09-17T11:39:50+02:00', undefined], ['2026-09-17 11:39:50Z', undefined], ['yesterday', undefined],
  ];
  for (const [resetsAt, expected] of cases) {
    const window = { status: 'ok', percent: 0, resetsAt };
    reply = { status: 200, body: JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } }) };
    const usage = await daemon.invoke('opencode_go_usage');
    expect(usage.rolling.resetAt, resetsAt).toBe(expected);
  }
}, 60_000);

test('settings saved before the newer options load with automatic retry kept on', async () => {
  const current = await daemon.invoke('load_app_settings');
  const older = { defaultThinking: 'medium', contextWindowCap: 200000, contextWindowCapEnabled: true, autoRetry: true, tools: [], skills: [], mcpServers: [] };
  const saved = await daemon.invoke('save_app_settings', { settings: { ...older, settingsRevision: current.settingsRevision } });
  expect(saved).toBeDefined();
  const loaded = await daemon.invoke('load_app_settings');
  expect(loaded).toMatchObject({ autoRetry: true, contextWindowCap: 200000 });
});
