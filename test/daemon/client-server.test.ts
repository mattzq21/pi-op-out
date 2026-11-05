import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fakeProgram, startDaemon, synchronizationFinished, temporaryDirectory, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop());

async function rawSocket(url: string) {
  const socket = new WebSocket(url);
  const packets: any[] = [];
  let closed = false;
  let closeCode: number | undefined;
  const changed = new Set<() => void>();
  socket.onmessage = message => { packets.push(JSON.parse(String(message.data))); for (const wake of [...changed]) wake(); };
  socket.onclose = event => { closed = true; closeCode = event.code; for (const wake of [...changed]) wake(); };
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('Could not connect')); });
  const close = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The daemon kept the socket open')), 10_000);
    const check = () => { if (closed) { clearTimeout(timer); changed.delete(check); resolve(); } };
    changed.add(check); check();
  });
  const packet = () => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No packet arrived')), 10_000);
    const check = () => { if (packets.length) { clearTimeout(timer); changed.delete(check); resolve(packets.shift()); } else if (closed) { clearTimeout(timer); changed.delete(check); reject(new Error('Socket closed')); } };
    changed.add(check); check();
  });
  return { send: (value: unknown) => socket.send(JSON.stringify(value)), sendRaw: (data: string | Uint8Array) => socket.send(data), packet, close, packets, end: () => socket.close(), closeCode: () => closeCode };
}

test('a connection that sends more than 4 KB before logging in is closed as too big, without a reply', async () => {
  const socket = await rawSocket(daemon.endpoint.url);
  socket.send({ type: 'authenticate', token: daemon.endpoint.token, padding: 'x'.repeat(5000) });
  await socket.close();
  expect(socket.closeCode()).toBe(1009);
  expect(socket.packets).toEqual([]);
});

test('after logging in, a request of a megabyte is accepted', async () => {
  const socket = await rawSocket(daemon.endpoint.url);
  socket.send({ type: 'authenticate', token: daemon.endpoint.token });
  expect(await socket.packet()).toMatchObject({ type: 'ready' });
  socket.send({ id: 1, command: 'load_app_settings', args: { padding: 'x'.repeat(1024 * 1024) } });
  let reply = await socket.packet();
  while (reply.event) reply = await socket.packet();
  expect(reply).toMatchObject({ id: 1, result: expect.objectContaining({ keybindings: expect.any(Object) }) });
  socket.end();
});

test('a connection authenticates only with the exact token in an authenticate packet', async () => {
  const { url, token } = daemon.endpoint;
  for (const first of [{}, { token }, { type: 'command', token }, { type: 'authenticate', token: 'wrong' }, { type: 'authenticate', token: token + 'x' }, { type: 'authenticate', token: token.slice(0, -1) }]) {
    const socket = await rawSocket(url);
    socket.send(first);
    expect(await socket.packet(), JSON.stringify(first)).toEqual({ type: 'error', error: 'Unauthorized' });
    await socket.close();
  }
  const socket = await rawSocket(url);
  socket.send({ type: 'authenticate', token });
  expect(await socket.packet()).toMatchObject({ type: 'ready', backend: 'daemon' });
  socket.end();
});

test('a first packet that is not a JSON authentication packet is refused with a reason', async () => {
  for (const [first, error] of [['{"type":"authenticate","token":', 'Invalid authentication'], [new Uint8Array([123, 125]), 'Expected authentication']] as const) {
    const socket = await rawSocket(daemon.endpoint.url);
    socket.sendRaw(first);
    expect(await socket.packet(), String(first)).toEqual({ type: 'error', error });
    await socket.close();
  }
});

test('a command sent before authentication is refused and never runs', async () => {
  const temporaryChats = async () => {
    const report = await daemon.invoke('storage_report');
    return report.hosts.find((host: any) => host.hostId === 'local').categories.find((category: any) => category.id === 'temporary-chats').itemCount;
  };
  expect(await temporaryChats()).toBe(0);
  const socket = await rawSocket(daemon.endpoint.url);
  socket.send({ id: 1, command: 'create_temporary_chat', args: { hostId: 'local' } });
  expect(await socket.packet()).toEqual({ type: 'error', error: 'Unauthorized' });
  await socket.close();
  expect(socket.packets).toEqual([]);
  expect(await temporaryChats()).toBe(0);
});

test('a malformed request after authentication closes only that connection with a reason, and later requests on it never run', async () => {
  const { url, token } = daemon.endpoint;
  const other = await daemon.connect();
  const sockets: Awaited<ReturnType<typeof rawSocket>>[] = [];
  const open = async () => { const socket = await rawSocket(url); sockets.push(socket); return socket; };
  try {
    const temporaryChats = async () => {
      const report = await other.invoke('storage_report');
      return report.hosts.find((host: any) => host.hostId === 'local').categories.find((category: any) => category.id === 'temporary-chats').itemCount;
    };
    expect(await temporaryChats()).toBe(0);
    const shape = 'Invalid request: expected {id, command, args}';
    for (const [malformed, error] of [
      ['{"id":1,"command":', expect.stringMatching(/^Invalid request: \S/)],
      ['null', shape], ['[1]', shape], ['{"id":-1,"command":"storage_report"}', shape], ['{"id":1.5,"command":"storage_report"}', shape], ['{"id":1}', shape],
    ] as const) {
      const socket = await open();
      socket.send({ type: 'authenticate', token });
      expect(await socket.packet()).toMatchObject({ type: 'ready', backend: 'daemon' });
      socket.sendRaw(malformed);
      socket.send({ id: 7, command: 'create_temporary_chat', args: { hostId: 'local' } });
      await socket.close();
      expect(socket.packets.filter(packet => !('event' in packet)), malformed).toEqual([{ error }]);
    }
    expect(await temporaryChats()).toBe(0);
    const settings = await other.invoke('load_app_settings');
    const saved = await other.invoke('save_app_settings', { settings });
    await other.waitEvent('pi://settings-changed', payload => payload.revision === saved.revision);
    const fresh = await open();
    fresh.send({ type: 'authenticate', token });
    expect(await fresh.packet()).toMatchObject({ type: 'ready', backend: 'daemon' });
    fresh.send({ id: 3, command: 'load_app_settings' });
    let reply;
    do reply = await fresh.packet(); while ('event' in reply);
    expect(reply).toEqual({ id: 3, result: await other.invoke('load_app_settings') });
  } finally {
    for (const socket of sockets) socket.end();
    other.close();
  }
});

async function arrivalSocket() {
  const path = join(temporaryDirectory('piop-arrivals-'), 'arrivals.sock');
  let count = 0;
  const waiters = new Set<() => void>();
  const server = createServer(socket => { socket.on('error', () => {}); count += 1; for (const wake of [...waiters]) wake(); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const arrivals = (wanted: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Only ' + count + ' of ' + wanted + ' programs started')); }, 10_000);
    const check = () => { if (count >= wanted) { clearTimeout(timer); waiters.delete(check); resolve(); } };
    waiters.add(check); check();
  });
  const program = '#!' + process.execPath + '\nrequire("node:net").connect(' + JSON.stringify(path) + ').on("error", () => {});\nsetTimeout(() => {}, 60_000);\n';
  return { arrivals, program, close: () => server.close() };
}

test('stop, abort and cancel requests still run when every work slot is busy, within their own small limit', async () => {
  const codex = await arrivalSocket();
  const ssh = await arrivalSocket();
  fakeProgram(daemon.bin, 'codex', codex.program);
  const slow = join(daemon.home, '.test-remotes', 'slow');
  mkdirSync(slow, { recursive: true }); fakeProgram(slow, '.ssh-hold', ssh.program);
  const settings = await daemon.invoke('load_app_settings');
  settings.hosts = [{ enabled: true, id: 'slow', name: 'Slow', target: 'slow', piPath: '~/.bun/bin/piopd' }];
  await synchronizationFinished(daemon, (await daemon.invoke('save_app_settings', { settings })).revision);
  const client = await daemon.connect();
  const settled = (promise: Promise<unknown>) => promise.then(() => 'answered', (error: Error) => error.message);
  const refresh = (target = client) => target.invoke('provider_usage', { refresh: true });
  const work = Array.from({ length: 16 }, () => settled(refresh()));
  try {
    await codex.arrivals(1);
    expect(await refresh().then(() => 'answered', (error: Error) => error.message)).toBe('Host is busy; try again');
    expect(await client.invoke('stop_pi', { runtimeId: 'missing' })).toBe(false);
    expect(await client.failure('pi_command', { runtimeId: 'missing', command: { type: 'abort' } })).toBe('Pi is not running');
    expect(await client.invoke('close_terminal', { terminalId: 'missing' })).toBeNull();
    const cancel = () => settled(client.invoke('provider_auth', { hostId: 'slow', request: { action: 'cancel' } }));
    const held = [cancel(), cancel()];
    await ssh.arrivals(1);
    expect(await cancel()).toBe('Host is busy; try again');
    expect(await client.failure('stop_pi', { runtimeId: 'missing' })).toBe('Host is busy; try again');
    const other = await daemon.connect();
    expect(await refresh(other).then(() => 'answered', (error: Error) => error.message)).toBe('Host is busy; try again');
    expect(await other.invoke('stop_pi', { runtimeId: 'missing' })).toBe(false);
    other.close();
    expect(await Promise.all(work)).toEqual(Array(16).fill('answered'));
    expect((await client.invoke('provider_usage', {})).codex).toEqual({ error: 'Codex usage request timed out' });
    client.close();
    await Promise.all(held);
  } finally {
    codex.close(); ssh.close();
    const current = await daemon.invoke('load_app_settings');
    current.hosts = [];
    await synchronizationFinished(daemon, (await daemon.invoke('save_app_settings', { settings: current })).revision);
  }
}, 60_000);
