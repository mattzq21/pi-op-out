import { cleanupScope } from '../cleanup-scope.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { installDom, act } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

async function settingsClient(t, options = {}) {
  t = cleanupScope(t);
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  const requests = new Set();
  let client;
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => { await client?.dispose(); await settle(); storage.restore(); clearMocks(); dom.restore(); });
  const native = await nativeFileCommand(t, { desktop: true });
  const daemon = await daemonClient(t, () => {}, options);
  mockIPC(async (command, args) => {
    const request = ['load_client_settings', 'save_client_settings'].includes(command) ? native.invoke(command, args) : daemon.invoke(command, args);
    requests.add(request);
    try { return await request; } finally { requests.delete(request); }
  }, { background: false, shouldMockEvents: true });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  const target = options.target ?? { hostId: options.remotes?.[0]?.id ?? 'local', cwd: join(native.directory, 'missing-project'), sessionId: crypto.randomUUID() };
  client = new NativeTransport(target);
  return { client, daemon, target };
}

test('a settings save remains stored when the selected conversation cannot reconnect', async t => {
  const { client, daemon, target } = await settingsClient(t, { remotes: [{ id: 'remote', name: 'Remote', target: 'before' }] });
  const previous = await daemon.invoke('load_app_settings');
  const next = { ...previous, hosts: previous.hosts.map(host => ({ ...host, target: 'unreachable-after' })) };
  await assert.rejects(client.saveSettings(next, true, undefined, 'daemon', previous), /Settings were saved, but this session could not reconnect:/);
  assert.equal((await daemon.invoke('load_app_settings')).hosts[0].target, 'unreachable-after');
  assert.equal(client.currentHostId(), 'remote');
  assert.equal(client.currentCwd(), target.cwd);
});

test('settings can be saved again without reconnecting an unavailable remote conversation', async t => {
  const { client, daemon } = await settingsClient(t, { remotes: [{ id: 'remote', name: 'Remote', target: 'before' }] });
  const previous = await daemon.invoke('load_app_settings');
  const next = { ...previous, hosts: previous.hosts.map(host => ({ ...host, target: 'unreachable-after' })) };
  await assert.rejects(client.saveSettings(next, true, undefined, 'daemon', previous), /Settings were saved, but this session could not reconnect:/);
  const saved = await daemon.invoke('load_app_settings');

  const result = await client.saveSettings(saved, false, 'remote', 'daemon', saved);
  assert.equal(result.settings.hosts[0].target, 'unreachable-after');
  assert.equal((await daemon.invoke('load_app_settings')).hosts[0].target, 'unreachable-after');
  assert.equal(client.currentHostId(), 'remote');
});

test('saving client preferences preserves newer daemon review settings', async t => {
  const { client, daemon } = await settingsClient(t);
  const initial = await daemon.invoke('load_app_settings');
  await daemon.invoke('save_host_settings', { hostId: 'local', agentsChanged: false, settings: { ...initial, reviewAgent: 'new/model' } });
  const current = (await client.loadSettingsChange()).settings;
  const result = await client.saveSettings({ ...current, reviewAgent: 'old/model', debugMode: true }, false, undefined, 'client', current);
  assert.equal(result.settings.reviewAgent, 'new/model');
  assert.equal(result.settings.debugMode, true);
  assert.equal((await daemon.invoke('load_app_settings')).reviewAgent, 'new/model');
  const reloaded = (await client.loadSettingsChange()).settings;
  assert.equal(reloaded.reviewAgent, 'new/model');
  assert.equal(reloaded.debugMode, true);
});


test('concurrent disposal notifies the consumer once and prevents reconnection', async t => {
  const { client } = await settingsClient(t, { target: {} });
  await client.connect();
  const disposed = [];
  client.onDispose(() => disposed.push('closed'));

  await Promise.all([client.dispose(), client.dispose()]);
  await client.dispose();
  assert.deepEqual(disposed, ['closed']);
  await assert.rejects(client.connect(), { message: 'This conversation view has been closed' });
});

test('queued settings wait for a command before moving a removed host to local', async t => {
  const { client } = await settingsClient(t, { target: { hostId: 'remote' }, remotes: [{ id: 'remote', name: 'Remote', target: 'before' }] });
  await client.connect();
  const applied = Promise.withResolvers();
  const timer = setTimeout(() => applied.reject(new Error('Settings were not applied')), 15000);
  t.after(() => clearTimeout(timer));
  let receivedApplied = false;
  client.subscribe(event => {
    if (event.type === 'settings_applied') receivedApplied = true;
    if (event.type === 'settings_pending' && !client.hasPendingSettings()) applied.resolve();
    if (event.type === 'extension_error') applied.reject(new Error(event.error));
  });
  const command = client.command({ type: 'get_commands' });
  client.queueSettings({ hosts: [] }, { reconnect: true });
  assert.equal(client.hasPendingSettings(), true);
  assert.equal(client.currentHostId(), 'remote');

  await Promise.all([command, applied.promise]);
  assert.equal(receivedApplied, true);
  assert.equal(client.currentHostId(), 'local');
  assert.equal(client.currentCwd(), undefined);
  assert.equal(client.isTemporaryChat(), true);
  assert.equal(client.hasPendingSettings(), false);
});

test('closed conversations ignore later queued settings', async t => {
  const { client, daemon } = await settingsClient(t, { target: {} });
  await client.connect();
  const settings = await daemon.invoke('load_app_settings');
  await client.dispose();
  const pendingEvents = [];
  client.subscribe(event => { if (event.type === 'settings_pending') pendingEvents.push(event); });

  client.queueSettings(settings, { reconnect: true });
  assert.equal(client.hasPendingSettings(), false);
  assert.deepEqual(pendingEvents, []);
  await assert.rejects(client.connect(), { message: 'This conversation view has been closed' });
});

test('a queued reconnect failure reports an error and keeps settings pending', async t => {
  const hostId = crypto.randomUUID();
  const { client, daemon } = await settingsClient(t, { target: { hostId }, remotes: [{ id: hostId, name: 'Remote', target: 'before' }] });
  const previous = await daemon.invoke('load_app_settings');
  const settings = { ...previous, hosts: previous.hosts.map(host => ({ ...host, target: 'unreachable-after' })) };
  await daemon.invoke('save_host_settings', { hostId: 'local', settings, agentsChanged: false });
  const failed = Promise.withResolvers();
  const timer = setTimeout(() => failed.reject(new Error('No reconnect failure was reported')), 15000);
  t.after(() => clearTimeout(timer));
  let message;
  client.subscribe(event => {
    if (event.type === 'extension_error') message = event.error;
    if (event.type === 'settings_pending' && message) failed.resolve();
  });

  client.queueSettings(settings, { reconnect: true });
  await failed.promise;
  assert.match(message, /^Settings saved, but this session could not apply them: .*Save again to retry\.$/s);
  assert.equal(client.hasPendingSettings(), true);
  assert.equal(client.currentHostId(), hostId);
});

test('a later queued update recovers from a failed remote reconnect', { timeout: 30000 }, async t => {
  const hostId = crypto.randomUUID();
  const { client, daemon } = await settingsClient(t, { target: { hostId }, remotes: [{ id: hostId, name: 'Remote', target: 'before' }] });
  const previous = await daemon.invoke('load_app_settings');
  const unavailable = { ...previous, hosts: previous.hosts.map(host => ({ ...host, target: 'unreachable-after' })) };
  await daemon.invoke('save_host_settings', { hostId: 'local', settings: unavailable, agentsChanged: false });
  const failed = Promise.withResolvers(), recovered = Promise.withResolvers();
  let failure, applied = false;
  client.subscribe(event => {
    if (event.type === 'extension_error') failure = event.error;
    if (event.type === 'settings_applied') applied = true;
    if (event.type === 'settings_pending' && failure && !applied) failed.resolve();
    if (event.type === 'settings_pending' && applied && !client.hasPendingSettings()) recovered.resolve();
  });
  client.queueSettings(unavailable, { reconnect: true });
  await failed.promise;
  assert.equal(client.hasPendingSettings(), true);

  const local = { ...await daemon.invoke('load_app_settings'), hosts: [] };
  await daemon.invoke('save_host_settings', { hostId: 'local', settings: local, agentsChanged: false });
  client.queueSettings(local, { reconnect: true });
  await recovered.promise;
  assert.equal(client.currentHostId(), 'local');
  assert.equal(client.hasPendingSettings(), false);
  const commands = await client.command({ type: 'get_commands' });
  assert.ok(Array.isArray(commands.commands));
});

test('settings updates that need no reconnect do not become pending', async t => {
  const { client, daemon } = await settingsClient(t, { target: {} });
  await client.connect();
  const settings = await daemon.invoke('load_app_settings');
  const pendingEvents = [];
  client.subscribe(event => { if (event.type === 'settings_pending') pendingEvents.push(event); });

  client.queueSettings(settings, { reconnect: false });
  assert.equal(client.hasPendingSettings(), false);
  assert.deepEqual(pendingEvents, []);
  assert.ok(Array.isArray((await client.command({ type: 'get_commands' })).commands));
});

test('connecting a draft leaves default application to the consumer', async t => {
  const { client } = await settingsClient(t, { target: {} });
  assert.equal(client.needsDefaults(), true);
  await client.connect();
  assert.equal(client.needsDefaults(), true);
});
