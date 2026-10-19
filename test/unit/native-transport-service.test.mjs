import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

test('transport shares concurrent connects, publishes presence and cleans up listeners', async t => {
  const dom = installDom();
  const calls = [], pending = new Set(), presenceListeners = new Set();
  let client;
  t.after(async () => {
    try { await client?.dispose(); await Promise.all([...pending]); }
    finally { clearMocks(); dom.restore(); }
  });
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    calls.push({ command: args.command, args: args.args });
    const request = daemon.invoke(args.command, args.args);
    pending.add(request);
    try {
      const result = await request;
      if (args.command === 'pi_presence') for (const notify of presenceListeners) notify(args.args.presence);
      return result;
    } finally { pending.delete(request); }
  }, { shouldMockEvents: true });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command,
    command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  t.mock.method(document, 'hasFocus', () => true);
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  t.after(() => { delete document.visibilityState; });
  const settle = async () => { while (pending.size) await Promise.all([...pending]); };
  const commands = name => calls.filter(call => call.command === name);
  const nextPresence = expectedVisible => new Promise((resolve, reject) => {
    const done = value => { if (value.visible !== expectedVisible) return; clearTimeout(timer); presenceListeners.delete(done); resolve(value); };
    const timer = setTimeout(() => { presenceListeners.delete(done); reject(new Error('Presence update did not complete')); }, 10_000);
    presenceListeners.add(done);
  });
  client = new NativeTransport({ cwd: home });
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(commands('start_pi').length, 1);
  assert.equal(commands('start_pi')[0].args.cwd, home);
  const visible = nextPresence(true);
  client.setVisible(true);
  assert.deepEqual(await visible, { visible: true, focused: true });
  const hidden = nextPresence(false);
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal((await hidden).visible, false);
  await client.connect();
  assert.equal(commands('start_pi').length, 1);
  await client.disconnect();
  const count = commands('pi_presence').length;
  window.dispatchEvent(new Event('focus'));
  await setImmediate();
  await settle();
  assert.equal(commands('pi_presence').length, count);
});
