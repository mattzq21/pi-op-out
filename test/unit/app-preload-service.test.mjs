import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emit } from '@tauri-apps/api/event';
import { appService } from '../app-service-fixture.mjs';
import { act, captureConsoleErrors } from '../dom.mjs';
import { settingsResources } from '../../clients/ui/lib/settingsResources.ts';

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

test('settings data loads without Pi only when the user points at Settings, and a settings change only drops it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = captureConsoleErrors();
  let cleanup, closed = false;
  t.after(async () => { try { if (!closed) await cleanup?.(); } finally { errors.release(); } });
  const { root, daemon, settle } = await appService({ after(callback) { cleanup = callback; } });
  // The settings page reads the host catalog. It must never start a Pi session for that.
  const reads = [], readers = [];
  const invoke = daemon.invoke;
  t.mock.method(daemon, 'invoke', (command, args) => {
    if (command === 'provider_auth' && args.request?.action === 'draft_catalog') reads.push(args.hostId);
    if (command === 'start_pi' && !args.sessionId && !args.sessionPath) readers.push(args.cwd);
    return invoke(command, args);
  });
  await act(() => t.mock.timers.tick(1000));
  await settle();
  const before = reads.length;
  await act(() => root.querySelector('button[aria-label="Settings"]').dispatchEvent(new Event('pointerenter')));
  await settle();
  assert.equal(reads.length, before + 1);
  const resources = await settingsResources('local');
  assert.ok(Array.isArray(resources.models));
  assert.ok(Array.isArray(resources.config.agents));
  assert.equal(reads.length, before + 1);
  const change = await daemon.invoke('load_settings_change');
  await emit('pi://host-settings-changed', { ...change, hostId: 'local' });
  await act(() => t.mock.timers.tick(2000));
  await settle();
  await settingsResources('local');
  assert.equal(reads.length, before + 2);
  assert.deepEqual(readers, []);
  await cleanup();
  closed = true;
  assert.deepEqual(errors.lines, []);
});
