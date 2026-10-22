import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeProgram, startDaemon, type TestDaemon } from './harness';

function publicSession(): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, cwd: daemon.home, folder: 'broker', content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Hello', timestamp: 1 } }) + '\n' }),
  }));
}

/*
 * The session broker is the HTTP service that Pi's extensions use to list and message other agents. A fake Pi
 * gets its address and token the same way real Pi does, from the environment of the Pi start.
 */
let daemon: TestDaemon;
let broker: { url: string; token: string; port: number };

/** The fake node plays Pi in RPC mode. It saves its environment and answers each request with success. */
function installFakePi(home: string): void {
  const bin = join(home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(require('node:path').join(process.env.HOME, 'pi-env.json'), JSON.stringify({ url: process.env.PI_DESKTOP_BROKER_URL, token: process.env.PI_DESKTOP_BROKER_TOKEN }));
const sessionFile = args[args.lastIndexOf('--session') + 1];
const sessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id;
const state = { sessionFile, sessionId, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: [], leafId: null } : null }) + '\\n');
});
`);
}

let open: { id: string; path: string };

beforeAll(async () => {
  daemon = await startDaemon();
  installFakePi(daemon.home);
  open = publicSession();
  expect(await daemon.invoke('start_pi', { runtimeId: 'open-runtime', clientId: 'test-client', cwd: daemon.home, sessionPath: open.path })).toMatchObject({ owned: true });
  const environment = JSON.parse(readFileSync(join(daemon.home, 'pi-env.json'), 'utf8'));
  broker = { ...environment, port: Number(new URL(environment.url).port) };
}, 60_000);
afterAll(async () => { await daemon?.stop(); });

type Answer = { status: number; headers: string; body: string; bytes: number };

/** Sends raw HTTP bytes to the broker and reads the full answer until the broker closes the connection. */
function raw(request: Buffer | string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(broker.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      const headers = all.subarray(0, end).toString('latin1');
      const body = all.subarray(end + 4);
      resolve({ status: Number(headers.split(' ')[1]), headers, body: body.toString('utf8'), bytes: body.length });
    });
    socket.write(request);
  });
}

function request(method: string, path: string, body?: unknown, token = broker.token): Promise<Answer> {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return raw(Buffer.concat([Buffer.from(method + ' ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' + token + '\r\nContent-Type: application/json\r\nContent-Length: ' + payload.length + '\r\n\r\n'), payload]));
}

const agents = async () => JSON.parse((await request('GET', '/agents')).body).data;

test('a started Pi gets the broker address and a UUID token, and the broker refuses other tokens', async () => {
  expect(broker.url).toBe('http://127.0.0.1:' + broker.port);
  expect(broker.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const token of ['', 'wrong', randomUUID()]) expect((await request('GET', '/agents', undefined, token)).status).toBe(401);
  expect((await request('GET', '/agents')).status).toBe(200);
});

test('broker answers are JSON with a content length in UTF-8 bytes and close the connection', async () => {
  const answer = await request('POST', '/orchestration', { action: 'read', hostId: 'café 🦆', sessionId: randomUUID() });
  expect(answer.status).toBe(400);
  expect(JSON.parse(answer.body)).toEqual({ error: 'Unknown host: café 🦆' });
  expect(answer.headers).toMatch(/^HTTP\/1\.1 400 /);
  expect(answer.headers).toMatch(/\r\ncontent-type: application\/json\r\n/i);
  expect(answer.headers).toMatch(/\r\nconnection: close\r\n/i);
  expect(answer.headers).toMatch(new RegExp('\\r\\ncontent-length: ' + answer.bytes + '(\\r\\n|$)', 'i'));
  expect(answer.bytes).toBeGreaterThan(answer.body.length);
});

test('request headers past the 16 KiB budget are refused and the broker keeps serving', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => 'X-Filler-' + index + ': ' + 'x'.repeat(500)).join('\r\n');
  const answer = await raw('GET /agents HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' + broker.token + '\r\n' + lines + '\r\n\r\n');
  expect(answer.status).toBe(431);
  expect((await request('GET', '/agents')).status).toBe(200);
});

test('header lines with bytes that are not UTF-8 are refused or read safely, and the broker keeps serving', async () => {
  const head = (lines: Buffer[]) => Buffer.concat([...lines.flatMap(line => [line, Buffer.from('\r\n')]), Buffer.from('\r\n')]);
  // A request line that is not text is a bad request.
  expect((await raw(head([Buffer.from([0xff])]))).status).toBe(400);
  // A token with such bytes can never match.
  expect((await raw(head([Buffer.from('GET /agents HTTP/1.1'), Buffer.from('Host: 127.0.0.1'), Buffer.concat([Buffer.from('Authorization: Bearer '), Buffer.from([0xff, 0xfe]), Buffer.from(broker.token.slice(2))])]))).status).toBe(401);
  // Other header values with such bytes do not change the answer.
  const answer = await raw(head([Buffer.from('GET /agents HTTP/1.1'), Buffer.from('Host: 127.0.0.1'), Buffer.from('Authorization: Bearer ' + broker.token), Buffer.concat([Buffer.from('X-Other: '), Buffer.from([0xff, 0xc3])])]));
  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.body).data).toEqual(await agents());
  expect((await request('GET', '/agents')).status).toBe(200);
});

test('the agent list marks open conversations as active', async () => {
  const closed = publicSession();
  const listed = new Map((await agents()).map((agent: any) => [agent.sessionId, agent.active]));
  expect(listed.get(open.id)).toBe(true);
  expect(listed.get(closed.id)).toBe(false);
});
