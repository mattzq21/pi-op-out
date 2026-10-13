import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import '../register-typescript.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';

globalThis.BroadcastChannel = class extends BroadcastChannel { constructor(name) { super(name); this.unref(); } };
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
globalThis.window = Object.assign(new EventTarget(), { crypto: globalThis.crypto, location: { search: '' }, innerWidth: 1200 });
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true, documentElement: { clientWidth: 1200 } });
const { NativeTransport } = await import('../../clients/ui/lib/nativeTransport.ts');

async function connected(t, commands) {
  const calls = [];
  mockIPC((command, args) => {
    if (command === 'start_pi') return { attached: false };

    if (command === 'stop_pi') return true;

    if (command !== 'pi_command') return undefined;
    calls.push(args.command);

    return args.command.type === 'get_commands' ? { commands } : {};
  }, { shouldMockEvents: true });
  const transport = new NativeTransport({ cwd: '/repo' });
  t.after(async () => { await transport.disconnect(); clearMocks(); });
  await transport.connect();

  return { transport, calls };
}

test('conversation fast-mode changes use the session command', async t => {
  const { transport, calls } = await connected(t, []);
  await transport.setFastMode(false);
  await transport.setFastMode(true);
  assert.deepEqual(calls.filter(command => command.type === 'set_fast_mode').map(({ type, enabled }) => ({ type, enabled })), [
    { type: 'set_fast_mode', enabled: false },
    { type: 'set_fast_mode', enabled: true },
  ]);
  assert.equal(calls.some(command => command.type === 'prompt'), false);
});
