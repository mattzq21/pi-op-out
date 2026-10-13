import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

const storagePath = fileURLToPath(new URL('../daemon/resources/session-broker/app-settings.cjs', import.meta.url));

export async function installRuntimeSettings({ dir, pi, ctx, settings, settingsPath }) {
  const initial = { explicitOnlySkills: [], ...settings };
  if (!settingsPath) throw new Error('A daemon-created runtime settings path is required');
  process.env.PIOP_RUNTIME_SETTINGS_PATH = settingsPath;
  const outfile = join(dir, 'real-runtime-settings.mjs');
  await build({
    entryPoints: ['extensions/piop-runtime-settings/index.ts'], outfile,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    plugins: [storageSchemaImports(), { name: 'runtime-extension-dependencies', setup(builder) {
      builder.onResolve({ filter: /^\.\/app-settings\.cjs$/ }, () => ({ path: storagePath }));
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const formatSkillsForPrompt = () => { throw new Error('Unexpected Pi SDK skill operation'); };
      ` }));
    } }],
  });
  const { default: register } = await import(pathToFileURL(outfile));
  await register(pi);
  // A prior SDK session can leave process-wide settings behind. Reset through
  // the extension's public command before loading any agent resources.
  const request = { command: 'runtime_settings', payload: { settings: initial }, ctx: { ...ctx, mode: 'rpc', reload: async () => {} } };
  pi.events.emit('piop:rpc', request);
  if (!request.ready) throw new Error('Runtime settings command was not registered');
  await request.ready;
  return () => register(pi);
}
