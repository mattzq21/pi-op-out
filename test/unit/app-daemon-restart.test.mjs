import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emit } from '@tauri-apps/api/event';
import { appService } from '../app-service-fixture.mjs';
import { act } from '../dom.mjs';

test('daemon restart defers chat listing without an error and reloads after reconnect', async t => {
  const { root, daemon, settle } = await appService(t);
  const invoke = daemon.invoke.bind(daemon);
  let restarting = true;
  let listings = 0;
  daemon.invoke = (command, args) => {
    if (command === 'list_sessions') {
      listings++;
      if (restarting) return Promise.reject(new Error('Piop daemon is shutting down'));
    }
    return invoke(command, args);
  };
  await act(async () => {
    await emit('pi://daemon-restarting', { hostId: 'local', restartId: 'test-restart' });
    await emit('pi://sessions-changed', {});
    await settle();
  });
  assert.ok(!root.textContent.includes('Could not load chats'), 'restart must not show Could not load chats');
  restarting = false;
  const before = listings;
  await act(async () => { await emit('pi://event', { type: 'connection_restored' }); await settle(); });
  assert.ok(listings > before, 'chat list reloads automatically after reconnect');
  assert.ok(!root.textContent.includes('Piop daemon is shutting down'));
});

test('chat list failures outside a restart remain visible', async t => {
  const { root, daemon, settle } = await appService(t);
  const invoke = daemon.invoke.bind(daemon);
  daemon.invoke = (command, args) => command === 'list_sessions'
    ? Promise.reject(new Error('Cannot read session storage')) : invoke(command, args);
  await act(async () => { await emit('pi://sessions-changed', {}); await settle(); });
  assert.ok(root.textContent.includes('Could not load chats'));
  assert.ok(root.textContent.includes('Cannot read session storage'));
});

test('a chat list request interrupted by restart is retried after reconnect', async t => {
  const { root, daemon, settle } = await appService(t);
  const invoke = daemon.invoke.bind(daemon);
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  let listings = 0;
  daemon.invoke = (command, args) => {
    if (command === 'list_sessions' && ++listings === 1) { started.resolve(); return pending.promise; }
    return invoke(command, args);
  };
  await act(async () => { await emit('pi://sessions-changed', {}); await started.promise; });
  await act(async () => {
    await emit('pi://daemon-restarting', { hostId: 'local' });
    await emit('pi://event', { type: 'connection_restored' });
    pending.reject(new Error('Piop daemon is shutting down'));
    await settle();
  });
  assert.ok(listings >= 2);
  assert.ok(!root.textContent.includes('Could not load chats'));
});
