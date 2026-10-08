import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: 'export { NativeTransport } from "./clients/ui/lib/nativeTransport"; export { calls, setCommands } from "./platform";', resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  define: { 'import.meta.env.MODE': '"test"' },
  plugins: [{ name: 'native-bridge', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)platform$/ }, args => ({ path: args.path, namespace: 'bridge' }));
    builder.onLoad({ filter: /.*/, namespace: 'bridge' }, () => ({ contents: `
      export const calls = [];
      export const isMobile = false;
      let commands = [];
      export function setCommands(value) { commands = value; calls.length = 0; }
      export async function invoke(name, args) {
        calls.push(args.command);
        return args.command.type === 'get_commands' ? { commands } : {};
      }
      export async function listen() { return () => {}; }
    ` }));
  } }],
});

const { NativeTransport, calls, setCommands } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

for (const packageName of ['piop-openai-fast-mode', 'pi-openai-fast-mode-piop', 'pi-openai-fast-mode']) {
  for (const sourceInfo of [{ path: `/home/test/.piop/${packageName}/index.ts` }, { source: `npm:${packageName}` }]) {
    test(`applies conversation fast-mode defaults from ${JSON.stringify(sourceInfo)}`, async t => {
      t.after(() => { delete globalThis.window; delete globalThis.document; });
      setCommands([
        { name: 'fast', source: 'extension', sourceInfo: { path: '/unrelated/extension/index.ts' } },
        { name: 'fast:2', source: 'extension', sourceInfo },
        { name: 'pi-desktop-fast-status', source: 'extension' },
      ]);
      const transport = new NativeTransport();
      globalThis.window = { innerWidth: 1200 };
      globalThis.document = { documentElement: { clientWidth: 1200 } };
      await transport.setFastMode(false);
      await transport.setFastMode(true);
      await transport.toggleFastMode();
      assert.deepEqual(calls.filter(command => command.message?.startsWith('/fast')), [
        { type: 'prompt', message: '/fast:2 off' },
        { type: 'prompt', message: '/fast:2 on' },
        { type: 'prompt', message: '/fast:2 toggle' },
      ]);
      assert.equal(calls.some(command => command.type === 'fast_mode_status'), packageName === 'pi-openai-fast-mode');
    });
  }
}
