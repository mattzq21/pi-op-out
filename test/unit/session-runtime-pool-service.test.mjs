import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emit } from '@tauri-apps/api/event';
import { installDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { SessionRuntimePool } from '../../clients/ui/lib/sessionRuntimePool.ts';

async function runtimePool(t, options = {}) {
  const dom = installDom();
  const pool = new SessionRuntimePool();
  const pending = new Set(), errors = [];
  let forwarding = false;
  pool.setErrorHandler(error => errors.push(error));
  t.after(async () => {
    try { await pool.disconnectAll(true); }
    finally {
      forwarding = false;
      await Promise.allSettled([...pending]);
      clearMocks(); dom.restore();
    }
  });
  const daemon = await daemonClient(t, (event, payload) => {
    if (!forwarding) return;
    const request = emit(event, payload);
    pending.add(request);
    request.then(() => pending.delete(request), error => { errors.push(error); pending.delete(request); });
  }, options);
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    return daemon.invoke(args.command, args.args);
  }, { shouldMockEvents: true });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  forwarding = true;
  return { pool, daemon, errors };
}

test('delayed pane cleanup cannot release a transport reused by a visible pane', async t => {
  const { pool, daemon, errors } = await runtimePool(t);
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const session = { id: chat.sessionId, cwd: chat.cwd, hostId: 'local' };
  const client = pool.forSession(session);
  await client.connect();
  await client.startDraft();
  pool.setInteractive(client, true);
  pool.setInteractive(client, false);
  pool.setInteractive(client, true);
  await pool.release(client);
  assert.equal(pool.forSession(session), client);
  assert.equal((await client.command({ type: 'get_state' })).sessionId, chat.sessionId);
  pool.setInteractive(client, false);
  await pool.release(client);
  assert.notEqual(pool.forSession(session), client);
  assert.deepEqual(errors, []);
});


test('settings reconnect only transports whose remote connection changed', async t => {
  const { pool, daemon, errors } = await runtimePool(t, { remotes: [
    { id: 'remote', name: 'Remote', target: 'before' },
    { id: 'replacement', name: 'Replacement', target: 'after' },
  ] });
  const local = pool.create({});
  const remote = pool.create({ hostId: 'remote' });
  await local.connect();
  await remote.connect();
  const previous = await daemon.invoke('load_app_settings');
  const renamed = { ...previous, hosts: previous.hosts.map(host => host.id === 'remote' ? { ...host, name: 'Renamed' } : host) };
  await daemon.invoke('save_host_settings', { hostId: 'local', settings: renamed, agentsChanged: false });
  pool.queueSettingsChange(previous, renamed);
  assert.equal(pool.pendingSettingsCount(), 0);
  const saved = await daemon.invoke('load_app_settings');
  const changed = { ...saved, hosts: saved.hosts.map(host => host.id === 'remote' ? { ...host, target: 'after' } : host) };
  await daemon.invoke('save_host_settings', { hostId: 'local', settings: changed, agentsChanged: false });
  pool.queueSettingsChange(saved, changed);
  assert.equal(pool.pendingSettingsCount(), 1);
  assert.equal(remote.hasPendingSettings(), true);
  assert.equal(local.hasPendingSettings(), false);
  assert.ok(Array.isArray((await remote.command({ type: 'get_commands' })).commands));
  assert.equal(pool.pendingSettingsCount(), 0);
  assert.ok(Array.isArray((await local.command({ type: 'get_commands' })).commands));
  assert.deepEqual(errors, []);
});

test('a conversation released while viewed stays usable until its last viewer closes', async t => {
  const { pool, daemon, errors } = await runtimePool(t);
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const session = { id: chat.sessionId, cwd: chat.cwd, hostId: 'local' };
  const client = pool.forSession(session);
  await client.connect();
  await client.startDraft();
  const closeFirst = pool.observe(client), closeSecond = pool.observe(client);
  await pool.release(client);
  closeFirst();
  closeFirst();
  assert.equal((await client.command({ type: 'get_state' })).sessionId, chat.sessionId);
  assert.equal(pool.forSession(session), client);
  const disposed = new Promise(resolve => client.onDispose(resolve));
  closeSecond();
  await disposed;
  assert.notEqual(pool.forSession(session), client);
  assert.deepEqual(errors, []);
});

test('a conversation reopened as active before its deferred release runs stays usable', async t => {
  const { pool, daemon, errors } = await runtimePool(t);
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const session = { id: chat.sessionId, cwd: chat.cwd, hostId: 'local' };
  const client = pool.forSession(session);
  await client.connect();
  await client.startDraft();
  const closeViewer = pool.observe(client);
  await pool.release(client);
  closeViewer();
  pool.activate(client);
  assert.equal((await client.command({ type: 'get_state' })).sessionId, chat.sessionId);
  assert.equal(pool.forSession(session), client);
  pool.activate(undefined);
  const disposed = new Promise(resolve => client.onDispose(resolve));
  await pool.release(client);
  await disposed;
  assert.notEqual(pool.forSession(session), client);
  assert.deepEqual(errors, []);
});
