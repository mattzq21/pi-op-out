import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

export async function compileAgentFixture(directory, { home = directory, files = {} } = {}) {
  const root = new URL('../extensions/piop-define-agents/', import.meta.url);

  for (const name of (await readdir(root)).filter(name => name.endsWith('.ts'))) {
    let source = await readFile(new URL(name, root), 'utf8');
    source = source.replace(/from "(\.\/[^"\n]+)\.ts"/g, 'from "$1.mjs"')
      .replace('import { homedir } from "node:os";', `const homedir = () => ${JSON.stringify(home)};`)
      .replace(/from "(typebox(?:\/value)?|zod)"/g, (_match, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);

    if (files['fs.mjs'] && ['index.ts', 'prompts.ts'].includes(name)) source = source.replace('from "node:fs/promises"', 'from "./fs.mjs"');
    await writeFile(join(directory, name.replace(/\.ts$/, '.mjs')), (await transform(source, { loader: 'ts', format: 'esm' })).code);
  }
}
