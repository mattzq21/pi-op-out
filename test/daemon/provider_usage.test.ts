import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { refreshedUsage, startDaemon, temporaryDirectory, type TestDaemon } from './harness';

let daemon: TestDaemon;
let home: string;
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
  home = temporaryDirectory('piop-home-');
  mkdirSync(join(home, '.opencodex'), { recursive: true });
  mkdirSync(join(home, '.test-bin'), { recursive: true });
  writeFileSync(join(home, '.test-bin/ocx'), '#!/bin/sh\necho "$*" >> "$HOME/ocx-calls"\ncat "$HOME/ocx-reply.json"\n', { mode: 0o755 });
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
  expect((await refreshedUsage(daemon, 'opencodeGo')).usage).toEqual({
    rolling: { status: 'ok', remainingPercent: 73, resetAt: 1789660800 },
    weekly: { status: 'ok', remainingPercent: 45, resetAt: 1789948800 },
    monthly: { status: 'rate-limited', remainingPercent: 0, resetAt: 1790726400 },
  });
  expect(requests.at(-1)).toEqual({ url: expect.stringContaining('/zen/go/v1/usage'), authorization: 'Bearer test-opencode-key' });
}, 60_000);

test('OpenCode Go usage without all three windows is unavailable, and a gateway error passes on its message', async () => {
  for (const body of [{ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }, { usage: { rolling: { status: 'ok', percent: 50 } } }, {}]) {
    reply = { status: 200, body: JSON.stringify(body) };
    expect((await refreshedUsage(daemon, 'opencodeGo')).error, JSON.stringify(body)).toBe('OpenCode Go usage is unavailable');
  }
  reply = { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }) };
  expect((await refreshedUsage(daemon, 'opencodeGo')).error).toBe('OpenCode Go usage is unavailable: Unauthorized');
}, 60_000);

test('a failed refresh keeps the last usage with the error, tells every client and logs the error once', async () => {
  const window = { status: 'ok', percent: 40 };
  reply = { status: 200, body: JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } }) };
  const usage = (await refreshedUsage(daemon, 'opencodeGo')).usage;
  expect(usage.rolling.remainingPercent).toBe(60);
  const other = await daemon.connect();
  try {
    reply = { status: 429, body: JSON.stringify({ error: { message: 'Rate limited' } }) };
    const error = 'OpenCode Go usage is unavailable: Rate limited';
    const changed = other.waitEvent('pi://usage-changed', payload => payload.opencodeGo?.error === error);
    expect(await refreshedUsage(daemon, 'opencodeGo')).toEqual({ usage, error });
    expect((await changed).opencodeGo).toEqual({ usage, error });
    await refreshedUsage(daemon, 'opencodeGo');
    expect(await other.invoke('provider_usage', {})).toMatchObject({ opencodeGo: { usage, error } });
    expect(daemon.log().split('\n').filter(line => line.includes('Usage of opencodeGo could not refresh: ' + error))).toHaveLength(1);
    reply = { status: 200, body: JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } }) };
    expect(await refreshedUsage(daemon, 'opencodeGo')).toEqual({ usage });
  } finally { other.close(); }
}, 60_000);

test('a refresh of one provider asks only that provider, and an unknown provider is refused', async () => {
  const window = { status: 'ok', percent: 10 };
  reply = { status: 200, body: JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } }) };
  const before = requests.length;
  await daemon.invoke('provider_usage', { refresh: true, provider: 'anthropic' });
  expect(requests.length).toBe(before);
  const usage = await daemon.invoke('provider_usage', { refresh: true, provider: 'opencodeGo' });
  expect(requests.length).toBe(before + 1);
  expect(usage.opencodeGo.usage.rolling.remainingPercent).toBe(90);
  expect(await daemon.failure('provider_usage', { refresh: true, provider: 'toString' })).toContain('Invalid provider');
}, 60_000);

test('a refresh of all providers right after a read uses that read, and a click on the badge still reads the provider', async () => {
  const window = { status: 'ok', percent: 20 };
  reply = { status: 200, body: JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } }) };
  const before = requests.length;
  await daemon.invoke('provider_usage', { refresh: true, provider: 'opencodeGo' });
  const all = await daemon.invoke('provider_usage', { refresh: true });
  expect(requests.length).toBe(before + 1);
  expect(all.opencodeGo.usage.rolling.remainingPercent).toBe(80);
  await daemon.invoke('provider_usage', { refresh: true, provider: 'opencodeGo' });
  expect(requests.length).toBe(before + 2);
}, 60_000);

test('reset times are read only from UTC ISO 8601 timestamps, with or without fractions', async () => {
  const cases: Array<[string, number | undefined]> = [
    ['2026-09-17T00:00:00.000Z', 1789603200], ['2026-09-17T11:39:50Z', 1789645190], ['2000-02-29T23:59:59Z', 951868799],
    ['2026-09-17T11:39:50+02:00', undefined], ['2026-09-17 11:39:50Z', undefined], ['yesterday', undefined],
  ];
  for (const [resetsAt, expected] of cases) {
    const window = { status: 'ok', percent: 0, resetsAt };
    reply = { status: 200, body: JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } }) };
    const usage = (await refreshedUsage(daemon, 'opencodeGo')).usage;
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

const ocxAccount = (key: string, quota: Record<string, number> | undefined, extra: Record<string, unknown> = {}) => ({ provider: 'openai', type: 'codex', upstreamAccountKey: key, needsReauth: false, ...(quota ? { quota } : {}), ...extra });

test('OCX usage lists each Codex account once with its weekly window', async () => {
  writeFileSync(join(home, 'ocx-reply.json'), JSON.stringify({ accounts: [
    ocxAccount('a', { shortPercent: 10, shortResetAt: 100, weeklyPercent: 40, weeklyResetAt: 200 }, { slotKind: 'native-main' }),
    ocxAccount('a', { shortPercent: 10, shortResetAt: 100, weeklyPercent: 40, weeklyResetAt: 200, monthlyPercent: 0, monthlyResetAt: 300 }, { slotKind: 'pool' }),
    ocxAccount('b', { shortPercent: 100, shortResetAt: 150, weeklyPercent: 60, weeklyResetAt: 250 }),
    ocxAccount('c', undefined, { needsReauth: true }),
    ocxAccount('d', undefined, { quotaRefresh: { status: 'error', error: 'Quota probe failed' } }),
    { provider: 'openai', type: 'api_key', upstreamAccountKey: 'e' },
  ], notes: [] }));
  expect((await refreshedUsage(daemon, 'opencodex')).usage).toEqual({ accounts: [
    { id: 'a', remainingPercent: 60, resetAt: 200 },
    { id: 'b', remainingPercent: 40, resetAt: 250 },
    { id: 'c', error: 'This account needs a new login in OCX' },
    { id: 'd', error: 'Quota probe failed' },
  ] });
  expect(readFileSync(join(home, 'ocx-calls'), 'utf8').trim().split('\n').at(-1)).toBe('account list openai --quota --refresh --json');
}, 60_000);

test('a hidden usage indicator is removed and not read until it is shown again', async () => {
  writeFileSync(join(home, 'ocx-reply.json'), JSON.stringify({ accounts: [ocxAccount('a', { weeklyPercent: 25, weeklyResetAt: 200 })] }));
  await refreshedUsage(daemon, 'opencodex');
  const save = async (hiddenUsageIndicators: string[]) => {
    const current = await daemon.invoke('load_app_settings');
    await daemon.invoke('save_app_settings', { settings: { ...current, hiddenUsageIndicators } });
  };
  const nextUsage = (match: (payload: any) => boolean) => {
    let skip = daemon.events.filter(event => event.event === 'pi://usage-changed').length;
    return daemon.waitEvent('pi://usage-changed', payload => skip-- <= 0 && match(payload));
  };
  const hidden = nextUsage(payload => payload.opencodex === undefined);
  await save(['opencodex']);
  await hidden;
  rmSync(join(home, 'ocx-calls'));
  expect((await daemon.invoke('provider_usage', { refresh: true, provider: 'opencodex' })).opencodex).toBeUndefined();
  expect(existsSync(join(home, 'ocx-calls'))).toBe(false);
  const shownEvent = nextUsage(payload => payload.opencodex !== undefined);
  await save([]);
  const shown = await shownEvent;
  expect(shown.opencodex.usage).toEqual({ accounts: [{ id: 'a', remainingPercent: 75, resetAt: 200 }] });
  await expect(save(['unknown'])).rejects.toThrow('hiddenUsageIndicators');
}, 60_000);

test('OCX usage says ocx is unavailable when its PATH has no ocx', async () => {
  const lonely = temporaryDirectory('piop-home-');
  mkdirSync(join(lonely, '.opencodex'), { recursive: true });
  const path = join(lonely, '.path');
  mkdirSync(path);
  for (const program of ['bun', 'node', 'pi']) symlinkSync(Bun.which(program)!, join(path, program));
  const other = await startDaemon({ home: lonely, env: { PATH: path + ':/usr/bin:/bin' } });
  try { expect((await refreshedUsage(other, 'opencodex')).usage).toEqual({ accounts: [], unavailable: true }); }
  finally { await other.stop(); }
}, 60_000);
