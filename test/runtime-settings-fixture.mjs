import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

const storagePath = fileURLToPath(new URL('../daemon/resources/session-broker/app-settings.cjs', import.meta.url));

async function bundle(dir, name, entry) {
  const outfile = join(dir, name);
  await build({
    entryPoints: [entry], outfile,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    plugins: [storageSchemaImports(), { name: 'runtime-extension-dependencies', setup(builder) {
      builder.onResolve({ filter: /^\.\.?\/app-settings\.cjs$/ }, () => ({ path: storagePath }));
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const formatSkillsForPrompt = () => { throw new Error('Unexpected Pi SDK skill operation'); };
      ` }));
    } }],
  });
  return (await import(pathToFileURL(outfile))).default;
}

/**
 * Loads the real skills store, tool store and runtime settings extensions.
 * settings.enabledTools is short for tool lists where every enabled tool is registered.
 */
export async function installRuntimeSettings({ dir, pi, ctx, settings, settingsPath }) {
  const { enabledTools = [], ...rest } = settings ?? {};
  const initial = {
    skills: { userInvokedSkills: [], agentInvokedSkills: [] }, tools: { enabledTools, registeredTools: enabledTools }, ...rest,
  };
  if (!settingsPath) throw new Error('A daemon-created runtime settings path is required');
  process.env.PIOP_SKILLS_STORE_PATH = join(dirname(settingsPath), 'skills-store.json');
  process.env.PIOP_TOOL_STORE_PATH = join(dirname(settingsPath), 'tool-store.json');
  const extensions = [
    await bundle(dir, 'real-skills-store.mjs', 'extensions/piop-skills-store/index.ts'),
    await bundle(dir, 'real-tool-store.mjs', 'extensions/piop-tool-store/index.ts'),
    await bundle(dir, 'real-runtime-settings.mjs', 'extensions/piop-runtime-settings/index.ts'),
  ];
  const register = async () => { for (const extension of extensions) await extension(pi); };
  await register();
  // A prior SDK session can leave process-wide settings behind. Reset through
  // the extension's public command before loading any agent resources.
  const request = { command: 'runtime_settings', payload: { settings: initial }, ctx: { ...ctx, mode: 'rpc', reload: async () => {} } };
  pi.events.emit('piop:rpc', request);
  if (!request.ready) throw new Error('Runtime settings command was not registered');
  await request.ready;
  return register;
}
