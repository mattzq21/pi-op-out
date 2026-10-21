import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeProgram, startDaemon, temporaryDirectory, type TestDaemon } from './harness';

function publicSession(): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, cwd: daemon.home, folder: 'broker', content: '' }),
  }));
}

/*
 * The session broker is the HTTP service that Pi's extensions use to list and message other agents. A fake Pi
 * gets its address and token the same way real Pi does, from the environment of the Pi start.
 */
let daemon: TestDaemon;
let broker: { url: string; token: string; port: number };
const held: Socket[] = [];
let arrived = 0;
const arrivalWaiters = new Set<() => void>();

/**
 * The fake node plays Pi. In RPC mode it saves its environment and answers each request with success. In print
 * mode, which the broker uses to message an agent, it reports its start on a socket, waits for a line from the
 * test and then prints a reply that names the message.
 */
function installFakePi(home: string, socket: string): void {
  const bin = join(home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--print')) {
  fs.writeFileSync(require('node:path').join(process.env.HOME, 'pi-print-args.json'), JSON.stringify(args));
  let message = '';
  process.stdin.on('data', chunk => { message += chunk; });
  const socket = require('node:net').connect(${JSON.stringify(socket)});
  socket.on('data', () => { process.stdout.write('reply to ' + message.trim() + '\\n'); process.exit(0); });
} else {
  fs.writeFileSync(require('node:path').join(process.env.HOME, 'pi-env.json'), JSON.stringify({ url: process.env.PI_DESKTOP_BROKER_URL, token: process.env.PI_DESKTOP_BROKER_TOKEN }));
  const sessionFile = args[args.lastIndexOf('--session') + 1];
  const sessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id;
  const state = { sessionFile, sessionId, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: [], leafId: null } : null }) + '\\n');
  });
}
`);
}

const arrivals = (wanted: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { arrivalWaiters.delete(check); reject(new Error('Only ' + arrived + ' of ' + wanted + ' agent messages started')); }, 10_000);
  const check = () => { if (arrived >= wanted) { clearTimeout(timer); arrivalWaiters.delete(check); resolve(); } };
  arrivalWaiters.add(check); check();
});
/** Lets every waiting agent message finish. */
const release = () => { for (const socket of held.splice(0)) socket.end('go\n'); };

let open: { id: string; path: string };

beforeAll(async () => {
  const socket = join(temporaryDirectory('piop-broker-'), 'arrivals.sock');
  const server = createServer(connection => { connection.on('error', () => {}); held.push(connection); arrived += 1; for (const wake of [...arrivalWaiters]) wake(); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  daemon = await startDaemon();
  installFakePi(daemon.home, socket);
  open = publicSession();
  expect(await daemon.invoke('start_pi', { runtimeId: 'open-runtime', clientId: 'test-client', cwd: daemon.home, sessionPath: open.path })).toMatchObject({ owned: true });
  const environment = JSON.parse(readFileSync(join(daemon.home, 'pi-env.json'), 'utf8'));
  broker = { ...environment, port: Number(new URL(environment.url).port) };
}, 60_000);
afterAll(async () => { release(); await daemon?.stop(); });

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

const message = (sessionId: string, text: string) => request('POST', '/message', { requestId: randomUUID(), hostId: 'local', sessionId, message: text, clientId: 'broker-client' });
const agents = async () => JSON.parse((await request('GET', '/agents')).body).data;

test('a started Pi gets the broker address and a UUID token, and the broker refuses other tokens', async () => {
  expect(broker.url).toBe('http://127.0.0.1:' + broker.port);
  expect(broker.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const token of ['', 'wrong', randomUUID()]) expect((await request('GET', '/agents', undefined, token)).status).toBe(401);
  expect((await request('GET', '/agents')).status).toBe(200);
});

/*
 * An agent that runs for one message has no input channel, so its task_success hook sends the event to the broker and
 * waits for the answer. The daemon applies the same save policy as for app chats, using the saved repository status.
 */
test('a one-message agent saves its final response through the broker, and a failed save is its error', async () => {
  const repository = join(daemon.home, 'broker-repository');
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  mkdirSync(repository);
  git('init', '--quiet');
  git('config', 'user.name', 'Piop Test');
  git('config', 'user.email', 'piop@example.com');
  writeFileSync(join(repository, 'README.md'), 'start\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  await daemon.invoke('validate_project_directory', { hostId: 'local', path: repository, newChat: true });
  const taskSuccess = (content: unknown[], name = 'task_success') => request('POST', '/runtime-event', { hostId: 'local', name, clientId: 'broker-client', data: {
    sessionId: randomUUID(), cwd: repository, turnIndex: 0, messageEntryId: 'entry', toolResultEntryIds: [], outcome: 'completed',
    message: { role: 'assistant', stopReason: content.some((part: any) => part.type === 'toolCall') ? 'toolUse' : 'stop', content },
  } });
  writeFileSync(join(repository, 'work.txt'), 'work\n');

  expect((await taskSuccess([{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }], 'turn_end')).status).toBe(200);
  expect(git('log', '--format=%s')).toBe('initial');
  expect((await taskSuccess([{ type: 'text', text: 'Done.' }])).status).toBe(200);
  expect(git('log', '--format=%s').split('\n')).toEqual(['Piop saving progress', 'initial']);

  writeFileSync(join(repository, 'more.txt'), 'more\n');
  writeFileSync(join(repository, '.git/index.lock'), '');
  const failed = await taskSuccess([{ type: 'text', text: 'Done again.' }]);
  expect(failed.status).not.toBe(200);
  expect(JSON.parse(failed.body).error).toContain('index.lock');
});

test('broker answers are JSON with a content length in UTF-8 bytes and close the connection', async () => {
  const answer = await message('café 🦆', 'hello');
  expect(answer.status).toBe(400);
  expect(JSON.parse(answer.body)).toEqual({ error: 'Agent local/café 🦆 was not found' });
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

test('a message needs both the machine and the conversation of an existing agent', async () => {
  const other = publicSession();
  for (const [hostId, sessionId] of [['local', 'missing'], ['local', other.id.toUpperCase()]]) {
    const answer = await request('POST', '/message', { requestId: randomUUID(), hostId, sessionId, message: 'hello', clientId: 'broker-client' });
    expect(JSON.parse(answer.body).error, hostId + '/' + sessionId).toBe('Agent ' + hostId + '/' + sessionId + ' was not found');
  }
  expect(JSON.parse((await request('POST', '/message', { requestId: randomUUID(), hostId: 'unknown', sessionId: other.id, message: 'hello', clientId: 'broker-client' })).body).error).toContain('unknown');
  const sent = message(other.id, 'found');
  await arrivals(arrived + 1);
  release();
  expect(JSON.parse((await sent).body)).toEqual({ data: { reply: 'reply to found' } });
  const printArgs: string[] = JSON.parse(readFileSync(join(daemon.home, 'pi-print-args.json'), 'utf8'));
  const extensionPaths = printArgs.filter((_, index) => printArgs[index - 1] === '--extension');
  expect(extensionPaths).toContain(join(daemon.home, '.piop/piop-providers-refresh.ts'));
});

test('concurrent messages claim an agent once, other agents stay free, and the claim ends with the reply', async () => {
  const busy = publicSession();
  const free = publicSession();
  const before = arrived;
  const settled: Answer[] = [];
  let wake = () => {};
  const answers = Array.from({ length: 8 }, (_, index) => message(busy.id, 'message ' + index).then(answer => { settled.push(answer); wake(); return answer; }));
  await arrivals(before + 1);
  // The 7 refused answers arrive while the one claim still waits for its reply.
  await new Promise<void>(resolve => { wake = () => { if (settled.length >= 7) resolve(); }; wake(); });
  expect(settled.map(answer => JSON.parse(answer.body).error)).toEqual(Array(7).fill('Agent local/' + busy.id + ' is already responding'));
  const listed = new Map((await agents()).map((agent: any) => [agent.sessionId, agent.active]));
  expect(listed.get(busy.id)).toBe(true);
  expect(listed.get(free.id)).toBe(false);
  // An open Pi conversation counts as active too.
  expect(listed.get(open.id)).toBe(true);
  const freeAnswer = message(free.id, 'free');
  await arrivals(before + 2);
  release();
  const replies = (await Promise.all(answers)).map(answer => JSON.parse(answer.body)).filter(value => value.data);
  expect(replies).toHaveLength(1);
  expect(replies[0].data.reply).toMatch(/^reply to message \d$/);
  expect(JSON.parse((await freeAnswer).body)).toEqual({ data: { reply: 'reply to free' } });
  expect(new Map((await agents()).map((agent: any) => [agent.sessionId, agent.active])).get(busy.id)).toBe(false);
  const again = message(busy.id, 'again');
  await arrivals(before + 3);
  release();
  expect(JSON.parse((await again).body)).toEqual({ data: { reply: 'reply to again' } });
}, 30_000);
