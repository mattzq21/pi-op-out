import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let bundle;
function compiledBridge() {
  return bundle ??= build({
    entryPoints: ['daemon/resources/mcp-bridge.ts'], write: false,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'external-mcp-sdk', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: './external-mcp-sdk.mjs', external: true }));
    } }],
  }).then(result => result.outputFiles[0].contents);
}

export async function installAgentMcp({ dir, pi, tools, servers: catalog = {}, start, registrationError, deferToolsUntilStart = false }) {
  const sdkPath = join(dir, 'external-mcp-sdk.mjs');
  await writeFile(sdkPath, 'let setup; export const setSetup = value => { setup = value; }; export const createMcpExtension = () => pi => setup(pi);');
  const sdk = await import(pathToFileURL(sdkPath));
  let adapter;
  let started = false;
  const registered = new Map();
  const publish = (name, config) => {
    if (config.enabled === false) return;
    const supplied = catalog[name] ?? [];
    for (const tool of supplied) adapter.registerTool(tool);
    adapter.setActiveTools([...new Set([...pi.getActiveTools(), ...supplied.map(tool => tool.name)])]);
  };
  sdk.setSetup(native => {
    adapter = native;
    native.on('session_start', async () => {
      await start?.();
      started = true;
      if (deferToolsUntilStart) for (const [name, config] of registered) publish(name, config);
    });
  });
  pi.registerMcpServer = (name, config) => {
    const failure = registrationError?.(name, config);
    if (failure !== undefined) throw failure;
    registered.set(name, structuredClone(config));
    if (!deferToolsUntilStart || started) publish(name, config);
  };
  pi.unregisterMcpServer = name => {
    registered.delete(name);
    const removed = new Set((catalog[name] ?? []).map(tool => tool.name));
    for (const name of removed) tools.delete(name);
    pi.setActiveTools(pi.getActiveTools().filter(name => !removed.has(name)));
  };
  const outfile = join(dir, 'real-agent-mcp.mjs');
  await writeFile(outfile, await compiledBridge());
  const { default: register } = await import(pathToFileURL(outfile));
  register(pi);
  return { registered };
}
