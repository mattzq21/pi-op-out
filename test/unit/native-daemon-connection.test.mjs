import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { nativeFileCommand } from '../native-file-command.mjs';

const REPOSITORY = fileURLToPath(new URL('../..', import.meta.url));
let executable;
const bundledDaemon = () => executable ??= process.env.PIOP_TEST_DAEMON_EXECUTABLE
  ?? execFileSync('bun', ['test/daemon/build.ts'], { cwd: REPOSITORY, encoding: 'utf8' }).trim();
const TOKEN = 'test-token-0123456789abcdef0123456789';

/**
 * The desktop app reads the build of the daemon it ships with from piopd beside its own executable,
 * and connects to the daemon named by PIOP_DAEMON_URL.
 */
async function bundledBuild() {
  const daemon = bundledDaemon();
  return execFileSync(daemon, ['--build-id'], { encoding: 'utf8' }).trim();
}

/** A daemon that speaks the desktop protocol; answer(request, socket) decides each reply. */
async function fakeDaemon(t, { buildId, answer = () => null }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const sockets = [];
  const requests = [];
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', async data => {
      const packet = JSON.parse(String(data));
      if (packet.type === 'authenticate') {
        socket.send(JSON.stringify(packet.token === TOKEN ? { type: 'ready', backend: 'daemon', protocol: 1, buildId } : { type: 'error', error: 'Unauthorized' }));
        return;
      }
      if (packet.type === 'ping') return;
      requests.push(packet);
      const reply = await answer(packet, socket);
      if (reply !== undefined) socket.send(JSON.stringify({ id: packet.id, result: reply }));
    });
  });
  t.after(() => new Promise(resolve => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  return { url: 'ws://127.0.0.1:' + server.address().port, sockets, requests, connections: () => sockets.length };
}

async function desktop(t, url, env = {}) {
  const native = await nativeFileCommand(t, { desktop: true, bundledDaemon: bundledDaemon(), env: { PIOP_DAEMON_URL: url, PIOP_DAEMON_TOKEN: TOKEN, PIOP_PREBUILT_DAEMON_FOR: REPOSITORY.replace(/\/$/, ''), ...env } });
  return {
    invoke: (command, args = {}) => native.invoke('daemon_invoke', { daemonCommand: command, args }),
    failure: (command, args = {}) => native.invoke('daemon_invoke', { daemonCommand: command, args }).then(() => 'succeeded', error => error.message),
    events: () => native.invoke('daemon_events'),
  };
}

async function until(check, what) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) { const value = await check(); if (value) return value; }
  throw new Error('Never happened: ' + what);
}

test('the desktop app sends daemon commands over one authenticated connection and returns their results', async t => {
  const buildId = await bundledBuild();
  const daemon = await fakeDaemon(t, { buildId, answer: request => ({ echoed: request.command, args: request.args }) });
  const app = await desktop(t, daemon.url);
  assert.deepEqual(await app.invoke('list_sessions', { hostId: 'local' }), { echoed: 'list_sessions', args: { hostId: 'local' } });
  assert.deepEqual(await app.invoke('load_app_settings'), { echoed: 'load_app_settings', args: {} });
  assert.equal(daemon.connections(), 1);
});

test('the desktop app refuses a daemon from another build and says which builds differ', async t => {
  const buildId = await bundledBuild();
  const daemon = await fakeDaemon(t, { buildId: 'piop-build-' + '0'.repeat(64) });
  const app = await desktop(t, daemon.url);
  assert.equal(await app.failure('list_sessions'), `Piop daemon is from another build; restart it. Bundled: ${buildId}; running: piop-build-${'0'.repeat(64)}`);
});

test('remote daemons need an encrypted address; plain ws is allowed only on this machine', async t => {
  await bundledBuild();
  const app = await desktop(t, 'ws://example.com:4000');
  assert.equal(await app.failure('list_sessions'), 'Remote daemons require wss://; ws:// is allowed only on loopback');
});

test('a lost connection fails waiting commands, closes open terminals and chats, and the next command reconnects', async t => {
  const buildId = await bundledBuild();
  let hold = false;
  const daemon = await fakeDaemon(t, { buildId, answer: request => hold && request.command === 'pi_command' ? undefined : request.command === 'start_pi' ? { owned: true } : null });
  const app = await desktop(t, daemon.url);
  await app.invoke('start_terminal', { terminalId: 'term-1' });
  await app.invoke('start_pi', { runtimeId: 'chat-1' });
  hold = true;
  const waiting = app.failure('pi_command', { runtimeId: 'chat-1', command: { type: 'get_state' } });
  await until(() => daemon.requests.some(request => request.command === 'pi_command'), 'the waiting command reached the daemon');
  daemon.sockets[0].terminate();
  assert.match(await waiting, /^Disconnected from the Piop daemon \(.+\); the command may have completed\.$/);
  const events = await until(async () => { const events = await app.events(); return events.length >= 2 && events; }, 'disconnect events');
  assert.deepEqual(events.map(event => event.payload), [{ type: 'terminal_exit', terminalId: 'term-1' }, { runtimeId: 'chat-1', event: { type: 'disconnected' } }]);

  hold = false;
  assert.equal(await app.invoke('list_sessions'), null);
  assert.equal(daemon.connections(), 2);
  assert.deepEqual((await app.events()).at(-1).payload, { type: 'connection_restored' });
});

test('after a daemon restart notice, the desktop app reconnects by itself when the daemon comes back', async t => {
  const buildId = await bundledBuild();
  const daemon = await fakeDaemon(t, { buildId });
  const app = await desktop(t, daemon.url);
  await app.invoke('list_sessions');
  daemon.sockets[0].send(JSON.stringify({ event: 'pi://daemon-restarting', payload: { hostId: 'local' } }));
  await until(async () => (await app.events()).some(event => event.event === 'pi://daemon-restarting'), 'the restart notice reached the window');
  daemon.sockets[0].close();
  await until(() => daemon.connections() === 2, 'the app reconnected without a command');
  await until(async () => (await app.events()).some(event => event.payload?.type === 'connection_restored'), 'the window heard the connection is back');
});
