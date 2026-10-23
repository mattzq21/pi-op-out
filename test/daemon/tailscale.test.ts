import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory, type TestDaemon } from './harness';

const OWNER = 'owner@example.com';
const status = (login: string, extra: Record<string, unknown> = {}) => JSON.stringify({ BackendState: 'Running', Self: { UserID: 7, ...extra }, User: { '7': { LoginName: login } } });

let daemon: TestDaemon;
let socketPath: string;

beforeAll(async () => {
  const home = temporaryDirectory('piop-home-');
  writeFileSync(join(home, '.fake-tailscale-status'), status(OWNER));
  writeFileSync(join(home, '.fake-tailscaled-pid'), process.pid + '\n');
  writeFileSync(join(home, '.fake-peer-credentials'), JSON.stringify({ uid: 0, pid: process.pid }));
  daemon = await startDaemon({ home, fakeTailscale: true });
  socketPath = join(home, '.piop/tailscale.sock');
}, 60_000);
afterAll(() => daemon?.stop());

function expectLog(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(join(daemon.home, '.piop'), () => check());
    const finish = (error?: Error) => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Missing daemon log message: ' + text + '\n' + daemon.log())), 5000);
    const check = () => { if (daemon.log().includes(text)) finish(); };
    watcher.on('error', finish);
    check();
  });
}

type Upgrade = { status: number; packets: any[]; send(value: unknown): void; next(): Promise<any>; closed(): Promise<void>; end(): void };

/** Opens the Tailscale socket like the tailscaled proxy and asks for a WebSocket upgrade with the given headers. */
function upgrade(headers: Record<string, string>): Promise<Upgrade> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let result: Upgrade | undefined;
    let ended = false;
    const wakes = new Set<() => void>();
    const wake = () => { for (const callback of [...wakes]) callback(); };
    const packets: any[] = [];
    const frames = () => {
      for (;;) {
        if (buffer.length < 2) return;
        let length = buffer[1]! & 0x7f; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const opcode = buffer[0]! & 0x0f; const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 1) packets.push(JSON.parse(payload.toString('utf8')));
        if (opcode === 8) ended = true;
        wake();
      }
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!result) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const status = Number(buffer.subarray(0, end).toString('latin1').split(' ')[1]);
        buffer = buffer.subarray(end + 4);
        result = {
          status, packets,
          send(value) {
            const payload = Buffer.from(JSON.stringify(value)); const mask = Buffer.from([1, 2, 3, 4]);
            const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
            socket.write(Buffer.concat([header, mask, payload.map((byte, index) => byte ^ mask[index % 4]!)]));
          },
          next: () => new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error('No packet arrived')), 10_000);
            const check = () => { if (packets.length) { clearTimeout(timer); wakes.delete(check); done(packets.shift()); } else if (ended) { clearTimeout(timer); wakes.delete(check); fail(new Error('Socket closed')); } };
            wakes.add(check); check();
          }),
          closed: () => new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error('The daemon kept the socket open')), 10_000);
            const check = () => { if (ended) { clearTimeout(timer); wakes.delete(check); done(); } };
            wakes.add(check); check();
          }),
          end: () => socket.destroy(),
        };
        resolve(result);
      }
      frames();
    });
    // Status 0: the daemon dropped the connection before any HTTP answer, with a close or a reset.
    const refused = () => { if (!result) resolve({ status: 0, packets, send() {}, next: () => Promise.reject(new Error('Socket closed')), closed: () => Promise.resolve(), end() {} }); };
    socket.on('close', () => { ended = true; wake(); refused(); });
    socket.on('error', error => { if (['ECONNRESET', 'EPIPE'].includes((error as any).code)) refused(); else if (!result) reject(error); });
    const lines = ['GET / HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
    for (const [name, value] of Object.entries(headers)) lines.push(name + ': ' + value);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  });
}

test('only the host Tailscale account may connect, without Funnel and from an app origin', async () => {
  const cases: Array<[string | undefined, string | undefined, number, number]> = [
    [undefined, undefined, 403, 403],
    [undefined, 'https://localhost', 403, 403],
    [undefined, 'capacitor://localhost', 403, 403],
    [undefined, 'https://evil.example', 403, 403],
    [undefined, 'http://localhost', 403, 403],
    ['other@example.com', undefined, 403, 403],
    ['other@example.com', 'https://localhost', 403, 403],
    ['other@example.com', 'capacitor://localhost', 403, 403],
    ['other@example.com', 'https://evil.example', 403, 403],
    ['other@example.com', 'http://localhost', 403, 403],
    [OWNER, undefined, 101, 403],
    [OWNER, 'https://localhost', 101, 403],
    [OWNER, 'capacitor://localhost', 101, 403],
    [OWNER, 'https://evil.example', 403, 403],
    [OWNER, 'http://localhost', 403, 403],
  ];
  for (const [login, origin, directStatus, funnelStatus] of cases) {
    for (const [funnel, expected] of [[false, directStatus], [true, funnelStatus]] as const) {
      const headers: Record<string, string> = {};
      if (login) headers['Tailscale-User-Login'] = login;
      if (origin) headers.Origin = origin;
      if (funnel) headers['Tailscale-Funnel-Request'] = '1';
      const connection = await upgrade(headers);
      try { expect(connection.status, JSON.stringify(headers)).toBe(expected); }
      finally { connection.end(); }
    }
  }
});

test('a Tailscale connection must choose Tailscale authentication in an authenticate packet', async () => {
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ type: 'authenticate', mode: 'tailscale' }, true],
    [{ type: 'command', mode: 'tailscale' }, false],
    [{ type: 'authenticate', mode: 'token' }, false],
    [{}, false],
  ];
  for (const [packet, accepted] of cases) {
    const connection = await upgrade({ 'Tailscale-User-Login': OWNER });
    expect(connection.status).toBe(101);
    connection.send(packet);
    if (accepted) {
      expect(await connection.next()).toMatchObject({ type: 'ready', backend: 'daemon' });
      connection.send({ id: 1, command: 'home_directory', args: { hostId: 'local' } });
      for (let reply = await connection.next(); ; reply = await connection.next()) if (reply.id === 1) { expect(typeof reply.result).toBe('string'); break; }
      connection.end();
    } else {
      await connection.closed();
      expect(connection.packets.filter(value => value.type === 'ready'), JSON.stringify(packet)).toEqual([]);
    }
  }
});

test('a proxy must be root and match the running tailscaled process', async () => {
  const peerFile = join(daemon.home, '.fake-peer-credentials');
  const pidFile = join(daemon.home, '.fake-tailscaled-pid');
  for (const [peer, service] of [
    [{ uid: 1000, pid: process.pid }, String(process.pid)],
    [{ uid: 0, pid: process.pid }, '1'],
    [{ uid: 0, pid: 0 }, '0'],
    [{ uid: 0, pid: -1 }, '-1'],
    [{ uid: 0, pid: process.pid }, 'invalid'],
  ] as const) {
    writeFileSync(peerFile, JSON.stringify(peer));
    writeFileSync(pidFile, service);
    try { expect((await upgrade({ 'Tailscale-User-Login': OWNER })).status, JSON.stringify({ peer, service })).toBe(0); }
    finally {
      writeFileSync(peerFile, JSON.stringify({ uid: 0, pid: process.pid }));
      writeFileSync(pidFile, process.pid + '\n');
    }
  }
  await expectLog('Tailscale connection rejected: Untrusted Tailscale proxy peer');
  const accepted = await upgrade({ 'Tailscale-User-Login': OWNER });
  try { expect(accepted.status).toBe(101); } finally { accepted.end(); }
});

test('a host must have a valid personal Tailscale identity', async () => {
  const statusFile = join(daemon.home, '.fake-tailscale-status');
  for (const [value, error] of [
    [status(OWNER, { Tags: ['tag:server'] }), 'Sign the host into a personal Tailscale account'],
    [JSON.stringify({ ...JSON.parse(status(OWNER)), BackendState: 'Stopped' }), 'Sign the host into a personal Tailscale account'],
    ['not json', 'Invalid Tailscale status'],
    [status(OWNER, { UserID: -1 }), 'Missing Tailscale host user'],
    [status(OWNER, { UserID: '7' }), 'Missing Tailscale host user'],
    [status(''), 'Missing Tailscale host login'],
    [status('non-ascii-\u00e9@example.com'), 'Missing Tailscale host login'],
    [JSON.stringify({ BackendState: 'Running', Self: { UserID: 7 }, User: {} }), 'Missing Tailscale host login'],
  ]) {
    writeFileSync(statusFile, value!);
    try { expect((await upgrade({ 'Tailscale-User-Login': OWNER })).status, value).toBe(0); }
    finally { writeFileSync(statusFile, status(OWNER)); }
    await expectLog('Tailscale connection rejected: ' + error);
  }
  const accepted = await upgrade({ 'Tailscale-User-Login': OWNER });
  try { expect(accepted.status).toBe(101); } finally { accepted.end(); }
});

test('startup replaces a stale Tailscale socket but refuses to remove a file or a link in its place', async () => {
  for (const kind of ['file', 'link'] as const) {
    const home = temporaryDirectory('piop-home-');
    const path = join(home, '.piop/tailscale.sock');
    mkdirSync(join(home, '.piop'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'keep'), 'keep me');
    if (kind === 'file') writeFileSync(path, 'keep me'); else symlinkSync(join(home, 'keep'), path);
    const failure = await startDaemon({ home }).then(started => started.stop().then(() => 'started'), (error: Error) => error.message);
    expect(failure, kind).toContain('Tailscale socket path is occupied by a non-socket file');
    expect(lstatSync(path).isSymbolicLink()).toBe(kind === 'link');
    expect(readFileSync(path, 'utf8')).toBe('keep me');
  }
  const home = temporaryDirectory('piop-home-');
  const path = join(home, '.piop/tailscale.sock');
  mkdirSync(join(home, '.piop'), { recursive: true, mode: 0o700 });
  // A socket file left behind by a daemon that did not stop cleanly.
  expect(spawnSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', path]).status).toBe(0);
  const started = await startDaemon({ home });
  try { expect(lstatSync(path).isSocket()).toBe(true); expect(existsSync(path)).toBe(true); }
  finally { await started.stop(); }
}, 60_000);
