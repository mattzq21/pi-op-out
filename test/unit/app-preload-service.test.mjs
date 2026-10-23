import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emit } from '@tauri-apps/api/event';
import { appService } from '../app-service-fixture.mjs';
import { act, captureConsoleErrors } from '../dom.mjs';
import { settingsResources } from '../../clients/ui/lib/settingsResources.ts';

test('closing the app before the settings preload does not start a settings reader later', async t => {
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

test('a mounted chat preloads settings and closing it cancels queued reloads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = captureConsoleErrors();
  let cleanup, closed = false;
  t.after(async () => { try { if (!closed) await cleanup?.(); } finally { errors.release(); } });
  const { daemon, settle } = await appService({ after(callback) { cleanup = callback; } });
  const started = Promise.withResolvers();
  const invoke = daemon.invoke;
  t.mock.method(daemon, 'invoke', (command, args) => {
    if (command === 'start_pi') started.resolve();
    return invoke(command, args);
  });
  await act(() => t.mock.timers.tick(1000));
  await started.promise;
  const resources = await settingsResources('local');
  assert.ok(Array.isArray(resources.models));
  assert.ok(Array.isArray(resources.levels));
  await settle();
  const change = await daemon.invoke('load_settings_change');
  await emit('pi://host-settings-changed', { ...change, hostId: 'local' });
  await cleanup();
  closed = true;
  await act(() => t.mock.timers.tick(2000));
  assert.deepEqual(errors.lines, []);
});
