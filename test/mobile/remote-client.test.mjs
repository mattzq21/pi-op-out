import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { z } from 'zod';

const compiled = await build({ entryPoints: ['src/lib/remoteClient.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });

const { RemoteClient, validateHost } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  sent = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

beforeEach(() => { globalThis.WebSocket = FakeSocket; FakeSocket.instances = []; });

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

test('authenticates before resolving connection; correlates out-of-order responses', async () => {
  const { client, socket } = await connected();

  try {
    assert.deepEqual(socket.sent[0], { type: 'authenticate', mode: 'tailscale' });
    const first = client.invoke('list_sessions'); const second = client.invoke('home_directory', { hostId: 'local' });
    socket.receive({ id: 2, result: '/home/me' }); socket.receive({ id: 1, result: [] });
    assert.deepEqual(await first, []); assert.equal(await second, '/home/me');
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

test('host errors propagate; explicit disconnect does not report connection loss', async () => {
  const { client, socket } = await connected(); let disconnected = false;
  client.onDisconnect = () => { disconnected = true; };

  const pending = client.invoke('start_pi'); const rejection = assert.rejects(pending, /Pi missing/);
  socket.receive({ id: 1, error: 'Pi missing' }); await rejection;
  client.close(); assert.equal(disconnected, false);
});

test('rejects older desktop endpoints without leaving a pending handshake', async () => {
  const client = new RemoteClient(); const promise = client.connect(host);
  const rejection = assert.rejects(promise, /older desktop endpoint/);
  const socket = FakeSocket.instances.at(-1);
  socket.onopen(); socket.receive({ type: 'ready', protocol: 1 });
  await rejection; assert.equal(socket.readyState, 3); client.close();
});
