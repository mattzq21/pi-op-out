import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

const root = new URL('../extensions/piop-define-agents/', import.meta.url);
const entries = ['index', 'prompts', 'extension-loader'];
const outputs = new Map();

async function bundled(filesystemAdapter = false) {
  if (outputs.has(filesystemAdapter)) return outputs.get(filesystemAdapter);
  const result = build({
    entryPoints: Object.fromEntries(entries.map(name => [name, fileURLToPath(new URL(`${name}.ts`, root))])),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, outdir: '/agent-fixture',
    plugins: [storageSchemaImports(), ...(filesystemAdapter ? [{
      name: 'external-filesystem-fixture',
      setup(context) {
        context.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: './fs.mjs', external: true }));
      },
    }] : [])], external: ['@earendil-works/*'], logLevel: 'silent',
  }).then(result => result.outputFiles.map(file => [file.path.replace('/agent-fixture/', '').replace(/\.js$/, '.mjs'), file.contents]));

  outputs.set(filesystemAdapter, result);
  return result;
}

export async function compileAgentFixture(directory) {
  await mkdir(directory, { recursive: true });

  for (const [name, contents] of await bundled(existsSync(join(directory, 'fs.mjs')))) await writeFile(join(directory, name), contents);
}
