import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { z } from 'zod';

const compiled = await build({ entryPoints: ['clients/ui/lib/remoteClient.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });

const { RemoteClient, validateHost } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  sent = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  send(data) { const packet = JSON.parse(data); this.sent.push(packet); this.onSend?.(packet); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

let previousGlobals;
beforeEach(() => {
  previousGlobals = new Map(['WebSocket', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.WebSocket = FakeSocket;
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  FakeSocket.instances = [];
});
afterEach(() => {
  for (const socket of FakeSocket.instances) socket.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const host = { url: 'wss://piop.example.test/mobile' };

async function connected() {
  const client = new RemoteClient(); const promise = client.connect(host);
  const socket = FakeSocket.instances.at(-1); socket.onopen(); socket.receive({ type: 'ready', protocol: 1, backend: 'daemon' }); await promise;

  return { client, socket };
}

test('requires TLS and keeps credentials out of URL', () => {
  assert.equal(validateHost(host), host.url);

  for (const url of ['ws://host', 'https://host', 'wss://user:password@host', 'wss://host?token=secret', 'wss://host#token']) assert.throws(() => validateHost({ ...host, url }));
});

test('responses received out of order reach their matching requests', async () => {
  const { client, socket } = await connected();
  try {
    const first = client.invoke('list_sessions');
    const second = client.invoke('home_directory', { hostId: 'local' });
    const listRequest = socket.sent.find(packet => packet.command === 'list_sessions');
    const homeRequest = socket.sent.find(packet => packet.command === 'home_directory');
    assert.notEqual(listRequest.id, homeRequest.id);
    socket.receive({ id: homeRequest.id, result: '/home/me' });
    socket.receive({ id: listRequest.id, result: [] });
    assert.deepEqual(await first, []);
    assert.equal(await second, '/home/me');
  } finally { client.close(); }
});

test('connection waits for host acceptance after sending authentication', async () => {
  const client = new RemoteClient();
  const promise = client.connect(host);
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  const socket = FakeSocket.instances.at(-1);
  try {
    socket.onopen();
    assert.deepEqual(socket.sent, [{ type: 'authenticate', mode: 'tailscale' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(client.isConnected(), false);
    socket.receive({ type: 'ready', protocol: 1, backend: 'daemon' });
    await promise;
    assert.equal(client.isConnected(), true);
  } finally { client.close(); }
});

test('forwards streamed events and unsubscribes cleanly', async () => {
  const { client, socket } = await connected(); const received = [];

  try {
    const remove = await client.listen('pi://event', ({ payload }) => received.push(payload), z.json().optional());
    socket.receive({ event: 'pi://event', payload: { type: 'message_update' } }); remove();
    socket.receive({ event: 'pi://event', payload: { type: 'message_end' } });
    assert.deepEqual(received, [{ type: 'message_update' }]);
  } finally { client.close(); }
});

test('disconnect rejects pending mutations without replaying them', async () => {
  const { client, socket } = await connected(); let disconnected = false;
  client.onDisconnect = () => { disconnected = true; };

  const pending = client.invoke('pi_command', { command: { type: 'prompt', message: 'build' } });
  const rejection = assert.rejects(pending, /may have completed/);
  socket.close(); await rejection;
  assert.equal(disconnected, true); assert.equal(socket.sent.length, 2);
  await assert.rejects(client.invoke('list_sessions'), /Connect/); client.close();
});

test('a host error rejects the matching request', async () => {
  const { client, socket } = await connected();
  const losses = [];
  client.onDisconnect = message => losses.push(message);
  try {
    const pending = client.invoke('start_pi');
    const rejection = assert.rejects(pending, /Pi missing/);
    const request = socket.sent.find(packet => packet.command === 'start_pi');
    socket.receive({ id: request.id, error: 'Pi missing' });
    await rejection;
    assert.equal(client.isConnected(), true);
    assert.deepEqual(losses, []);
    const next = client.invoke('home_directory', { hostId: 'local' });
    const homeRequest = socket.sent.find(packet => packet.command === 'home_directory');
    socket.receive({ id: homeRequest.id, result: '/home/me' });
    assert.equal(await next, '/home/me');
  } finally { client.close(); }
});

test('explicit disconnect does not report connection loss', async () => {
  const { client } = await connected();
  const losses = [];
  client.onDisconnect = message => losses.push(message);
  assert.equal(client.isConnected(), true);
  client.close();
  assert.equal(client.isConnected(), false);
  assert.deepEqual(losses, []);
});

test('failed authentication reports the host reason and leaves the client unusable', async () => {
  const client = new RemoteClient(); const losses = [];
  client.onDisconnect = message => losses.push(message);
  try {
    const promise = client.connect(host);
    const rejection = assert.rejects(promise, { message: 'Device is not allowed on this tailnet' });
    const socket = FakeSocket.instances.at(-1);
    socket.onopen(); socket.receive({ type: 'error', error: 'Device is not allowed on this tailnet' });
    await rejection;
    assert.equal(socket.readyState, 3);
    assert.equal(client.isConnected(), false);
    await assert.rejects(client.invoke('list_sessions'), /Connect/);
    assert.deepEqual(losses, []);
  } finally { client.close(); }
});

test('late events from a replaced connection do not affect the new connection', async () => {
  const { client, socket: replaced } = await connected(); const losses = [];
  client.onDisconnect = message => losses.push(message);
  try {
    const reconnect = client.connect(host);
    const current = FakeSocket.instances.at(-1);
    current.onopen(); current.receive({ type: 'ready', protocol: 1, backend: 'daemon' });
    await reconnect;
    const pending = client.invoke('home_directory', { hostId: 'local' });
    const request = current.sent.find(packet => packet.command === 'home_directory');
    replaced.receive({ id: request.id, result: '/stale' });
    replaced.receive({ type: 'not a packet', id: 'bad' });
    replaced.onclose();
    assert.equal(client.isConnected(), true);
    assert.deepEqual(losses, []);
    current.receive({ id: request.id, result: '/home/me' });
    assert.equal(await pending, '/home/me');
  } finally { client.close(); }
});

test('a log failure reported before connection loss is not replayed to listeners after reconnecting', async () => {
  const { client, socket: lost } = await connected();
  const status = z.object({ hostId: z.string(), failure: z.string().nullable() });
  try {
    lost.receive({ event: 'pi://daemon-log-status', payload: { hostId: 'ves', failure: 'Disk full' } });
    lost.close();
    const reconnect = client.connect(host);
    const current = FakeSocket.instances.at(-1);
    current.onopen(); current.receive({ type: 'ready', protocol: 1, backend: 'daemon' });
    await reconnect;
    current.receive({ event: 'pi://daemon-log-status', payload: { hostId: 'zqvps', failure: 'Log unreadable' } });
    const received = [];
    await client.listen('pi://daemon-log-status', ({ payload }) => received.push(payload), status);
    assert.deepEqual(received, [{ hostId: 'zqvps', failure: 'Log unreadable' }]);
  } finally { client.close(); }
});

test('connection loss ends only terminals still running and a later connection does not end them again', async () => {
  const { client, socket: lost } = await connected();
  const exits = [];
  const event = z.object({ type: z.string(), terminalId: z.string().optional() });
  try {
    await client.listen('pi://event', ({ payload }) => { if (payload.type === 'terminal_exit') exits.push(payload.terminalId); }, event);
    for (const terminalId of ['lifecycle-exited-terminal', 'lifecycle-running-terminal']) {
      const started = client.invoke('start_terminal', { terminalId, sessionKey: 'local:lifecycle-session', cwd: '/home/me', cols: 80, rows: 24 });
      const request = lost.sent.find(packet => packet.command === 'start_terminal' && packet.args.terminalId === terminalId);
      lost.receive({ id: request.id, result: null });
      await started;
    }
    lost.receive({ event: 'pi://event', payload: { type: 'terminal_exit', terminalId: 'lifecycle-exited-terminal' } });
    lost.close();
    assert.deepEqual(exits, ['lifecycle-exited-terminal', 'lifecycle-running-terminal']);

    const reconnect = client.connect(host);
    const current = FakeSocket.instances.at(-1);
    current.onopen(); current.receive({ type: 'ready', protocol: 1, backend: 'daemon' });
    await reconnect;
    client.close();
    assert.deepEqual(exits, ['lifecycle-exited-terminal', 'lifecycle-running-terminal']);
  } finally { client.close(); }
});

test('rejects older desktop endpoints without leaving a pending handshake', async () => {
  const client = new RemoteClient(); const promise = client.connect(host);
  const rejection = assert.rejects(promise, /older desktop endpoint/);
  const socket = FakeSocket.instances.at(-1);
  socket.onopen(); socket.receive({ type: 'ready', protocol: 1 });
  await rejection; assert.equal(socket.readyState, 3); client.close();
});

test('a host that never accepts times out after fifteen seconds and a later connection works undisturbed', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const client = new RemoteClient(); const losses = [];
  client.onDisconnect = message => losses.push(message);
  try {
    let outcome;
    void client.connect(host).then(() => { outcome = 'unexpected success'; }, error => { outcome = error; });
    const silent = FakeSocket.instances.at(-1);
    let deliverClose;
    silent.close = () => { silent.readyState = 2; deliverClose = () => { silent.readyState = 3; silent.onclose?.(); }; };
    silent.onopen();
    context.mock.timers.tick(14999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, undefined, 'The handshake must wait the full fifteen seconds');
    context.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(outcome instanceof Error, 'The handshake must fail after fifteen seconds');
    assert.match(outcome.message, /Connection timed out/);
    assert.equal(silent.readyState, 2, 'The timed out socket must be closed');
    assert.equal(client.isConnected(), false);
    await assert.rejects(client.invoke('list_sessions'), /Connect/);

    const retry = client.connect(host);
    const current = FakeSocket.instances.at(-1);
    current.onopen(); current.receive({ type: 'ready', protocol: 1, backend: 'daemon' });
    await retry;
    deliverClose();
    context.mock.timers.tick(15000);
    assert.equal(client.isConnected(), true);
    assert.deepEqual(losses, []);
    const next = client.invoke('home_directory', { hostId: 'local' });
    const request = current.sent.find(packet => packet.command === 'home_directory');
    current.receive({ id: request.id, result: '/home/me' });
    assert.equal(await next, '/home/me');
  } finally { client.close(); }
});

test('busy responses retry a rejected mutation without duplicating its accepted execution', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket } = await connected();
  let busy = 2;
  let accepted = 0;
  socket.onSend = packet => {
    if (packet.command !== 'pi_command') return;

    if (busy-- > 0) socket.receive({ id: packet.id, error: 'Host is busy; try again' });
    else { accepted++; socket.receive({ id: packet.id, result: { accepted: true } }); }
  };

  try {
    const pending = client.invoke('pi_command', { command: { type: 'prompt', message: 'one message' } });
    const result = pending.catch(error => ({ error: error.message }));
    context.mock.timers.tick(1000);
    context.mock.timers.tick(1000);
    assert.deepEqual(await result, { accepted: true });
    assert.equal(accepted, 1);
    const attempts = socket.sent.filter(packet => packet.command === 'pi_command');

    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map(packet => packet.id)).size, 1);
  } finally { client.close(); }
});

test('persistent saturation reports failure within ten seconds and stops retrying', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket } = await connected();
  socket.onSend = packet => { if (packet.command) socket.receive({ id: packet.id, error: 'Host is busy; try again' }); };
  try {
    let outcome;
    const pending = client.invoke('list_sessions').then(
      () => { outcome = 'unexpected success'; },
      error => { outcome = error; },
    );
    for (let tick = 0; tick < 10; tick++) context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(outcome instanceof Error, 'The caller must receive a failure within ten seconds');
    assert.match(outcome.message, /Host is busy; try again/);
    await pending;
    const attemptsAtFailure = socket.sent.filter(packet => packet.command).length;
    context.mock.timers.tick(10000);
    assert.equal(socket.sent.filter(packet => packet.command).length, attemptsAtFailure, 'No request is retried after failure');
  } finally { client.close(); }
});

test('a send failure during a busy retry reaches the caller, is never replayed, and the connection stays usable', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket } = await connected(); const losses = [];
  client.onDisconnect = message => losses.push(message);
  const sendFailure = new Error('WebSocket send failed: buffer full');
  let attempts = 0;
  const deliver = socket.send.bind(socket);
  socket.send = data => {
    const packet = JSON.parse(data);
    if (packet.command === 'pi_command' && ++attempts === 2) throw sendFailure;
    deliver(data);
    if (packet.command === 'pi_command') socket.receive({ id: packet.id, error: 'Host is busy; try again' });
  };
  try {
    let outcome;
    void client.invoke('pi_command', { command: { type: 'prompt', message: 'one message' } })
      .then(() => { outcome = 'unexpected success'; }, error => { outcome = error; });
    context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(outcome instanceof Error, 'The caller must receive a failure as soon as the retry send fails');
    assert.equal(outcome.message, 'WebSocket send failed: buffer full');
    assert.equal(client.isConnected(), true);
    assert.deepEqual(losses, []);

    const next = client.invoke('home_directory', { hostId: 'local' });
    const homeRequest = socket.sent.find(packet => packet.command === 'home_directory');
    socket.receive({ id: homeRequest.id, result: '/home/me' });
    assert.equal(await next, '/home/me');

    context.mock.timers.tick(700000);
    assert.equal(attempts, 2, 'The failed request is never sent again');
    assert.equal(client.isConnected(), true);
  } finally { client.close(); }
});

test('disconnect cancels a busy retry and never replays it on the next connection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket } = await connected();
  const pending = client.invoke('shared_terminal', { action: 'write', data: 'one command\r' });
  const rejection = assert.rejects(pending, /Disconnected.*may have completed/);
  const request = socket.sent.find(packet => packet.command === 'shared_terminal');
  socket.receive({ id: request.id, error: 'Host is busy; try again' });
  socket.close();
  await rejection;
  const reconnect = client.connect(host);
  const next = FakeSocket.instances.at(-1);
  next.onopen(); next.receive({ type: 'ready', protocol: 1, backend: 'daemon' });
  await reconnect;
  context.mock.timers.tick(10000);
  assert.equal(socket.sent.filter(packet => packet.command).length, 1);
  assert.equal(next.sent.filter(packet => packet.command).length, 0);
  client.close();
});

function returnToForeground() {
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
}

test('a silent host after returning to the foreground ends the connection and fails pending requests', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { client, socket } = await connected(); const losses = [];
  client.onDisconnect = message => losses.push(message);
  try {
    const pending = client.invoke('list_sessions');
    const rejection = assert.rejects(pending, /Disconnected.*may have completed/);
    returnToForeground();
    assert.ok(socket.sent.some(packet => packet.type === 'ping'));
    context.mock.timers.tick(10000);
    assert.deepEqual(losses, ['Connection stopped responding. Reconnecting…']);
    assert.equal(client.isConnected(), false);
    await rejection;
    await assert.rejects(client.invoke('list_sessions'), /Connect/);
  } finally { client.close(); }
});

test('a timely pong after returning to the foreground keeps the connection usable', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { client, socket } = await connected(); const losses = [];
  client.onDisconnect = message => losses.push(message);
  try {
    returnToForeground();
    context.mock.timers.tick(2000);
    socket.receive({ type: 'pong' });
    context.mock.timers.tick(10000);
    assert.deepEqual(losses, []);
    assert.equal(client.isConnected(), true);
    const next = client.invoke('home_directory', { hostId: 'local' });
    const request = socket.sent.find(packet => packet.command === 'home_directory');
    socket.receive({ id: request.id, result: '/home/me' });
    assert.equal(await next, '/home/me');
  } finally { client.close(); }
});
