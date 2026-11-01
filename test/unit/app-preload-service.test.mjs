import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { emit } from '@tauri-apps/api/event';
import { appService } from '../app-service-fixture.mjs';
import { act, captureConsoleErrors } from '../dom.mjs';
import { settingsResources } from '../../clients/ui/lib/settingsResources.ts';

const SystemAbortSignal = globalThis.AbortSignal;

test('closing the app before the settings page preload does not load it later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = captureConsoleErrors();
  let cleanup, closed = false;
  t.after(async () => { try { if (!closed) await cleanup?.(); } finally { errors.release(); } });
  await appService({ after(callback) { cleanup = callback; } });
  await cleanup();
  closed = true;
  await act(async () => {
    t.mock.timers.tick(1000);
    await import('../../clients/ui/lib/settingsResources.ts');
  });
  assert.deepEqual(errors.lines, []);
});

test('settings data loads only when the user points at Settings, and a settings change only drops it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = captureConsoleErrors();
  let cleanup, closed = false;
  t.after(async () => { try { if (!closed) await cleanup?.(); } finally { errors.release(); } });
  const { root, daemon, settle } = await appService({ after(callback) { cleanup = callback; } });
  // Each settings read starts a Pi session in the home folder.
  const readers = [], reads = new EventEmitter();
  const invoke = daemon.invoke;
  t.mock.method(daemon, 'invoke', (command, args) => {
    if (command === 'start_pi' && !args.sessionId && !args.sessionPath) { readers.push(args.cwd); reads.emit('start'); }
    return invoke(command, args);
  });
  await act(() => t.mock.timers.tick(1000));
  await settle();
  assert.deepEqual(readers, []);
  const firstRead = once(reads, 'start', { signal: SystemAbortSignal.timeout(3000) });
  await act(async () => {
    root.querySelector('button[aria-label="Settings"]').dispatchEvent(new Event('pointerenter'));
    await assert.doesNotReject(firstRead, 'pointing at Settings must start loading settings data');
  });
  const resources = await settingsResources('local');
  assert.ok(Array.isArray(resources.models));
  assert.ok(Array.isArray(resources.levels));
  assert.equal(readers.length, 1);
  // The first read saves the models it sees as known; that settings change drops the data once.
  await settle();
  await settingsResources('local');
  await settle();
  const loaded = readers.length;
  await settingsResources('local');
  assert.equal(readers.length, loaded);
  const change = await daemon.invoke('load_settings_change');
  await emit('pi://host-settings-changed', { ...change, hostId: 'local' });
  await act(() => t.mock.timers.tick(2000));
  await settle();
  assert.equal(readers.length, loaded);
  await settingsResources('local');
  assert.equal(readers.length, loaded + 1);
  await cleanup();
  closed = true;
  assert.deepEqual(errors.lines, []);
});
