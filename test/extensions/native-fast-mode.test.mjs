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

for (const packageName of ['piop-openai-fast-mode', 'pi-openai-fast-mode-piop', 'pi-openai-fast-mode']) {
  for (const sourceInfo of [{ path: `/home/test/.piop/${packageName}/index.ts` }, { source: `npm:${packageName}` }]) {
    test(`applies conversation fast-mode defaults from ${JSON.stringify(sourceInfo)}`, async t => {
      const { transport, calls } = await connected(t, [
        { name: 'fast', source: 'extension', sourceInfo: { path: '/unrelated/extension/index.ts' } },
        { name: 'fast:2', source: 'extension', sourceInfo },
        { name: 'pi-desktop-fast-status', source: 'extension' },
      ]);
      await transport.setFastMode(false);
      await transport.setFastMode(true);
      await transport.toggleFastMode();
      assert.deepEqual(calls.filter(command => command.message?.startsWith('/fast')).map(({ type, message }) => ({ type, message })), [
        { type: 'prompt', message: '/fast:2 off' },
        { type: 'prompt', message: '/fast:2 on' },
        { type: 'prompt', message: '/fast:2 toggle' },
      ]);
      assert.equal(calls.some(command => command.type === 'fast_mode_status'), packageName === 'pi-openai-fast-mode');
    });
  }
}
