import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Pi loads its extensions through jiti. jiti maps these imports to Pi's own copies and gives each file `require`.
const PI_PROVIDED = ['@earendil-works/*', 'typebox', 'typebox/*'];

const BUNDLES = {
  'pi-extension': () => ({ format: 'esm', external: PI_PROVIDED }),
  // Node runs these files itself, so they contain every dependency.
  'node-program': path => path.endsWith('.cjs') ? { format: 'cjs' } : {
    format: 'esm',
    banner: { js: "import { createRequire as __piopCreateRequire } from 'node:module';\nconst require = __piopCreateRequire(import.meta.url);" },
  },
};

async function bundle(path, kind) {
  const result = await build({
    entryPoints: [path], outdir: '/bundle', write: false, metafile: true, bundle: true,
    platform: 'node', target: 'node22', loader: { '.txt': 'text' }, logLevel: 'silent',
    ...BUNDLES[kind](path),
  });
  if (result.outputFiles.length !== 1) throw new Error('Expected one file from ' + path);
  return {
    contents: result.outputFiles[0].text, loader: 'text', warnings: result.warnings,
    watchFiles: Object.keys(result.metafile.inputs).map(input => resolve(input)),
  };
}

// The daemon's own import forms, for every build of daemon code:
// - `import text from './file?raw'` gives the file's text.
// - `import text from './entry.ts?pi-extension' with { type: 'text' }` gives the entry and all its imports built into one file
//   that Pi loads. `?node-program` does the same for a file that Node runs. Bun alone (in tests) gives the entry's text instead.
// - `piop-agent-loader` is the agent definitions loader.
export function daemonImports() {
  return {
    name: 'daemon-imports',
    setup(context) {
      context.onResolve({ filter: /^piop-agent-loader$/ }, () => ({ path: join(root, 'extensions/piop-define-agents/daemon-loader.ts') }));
      context.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      context.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text', watchFiles: [args.path] }));
      context.onResolve({ filter: new RegExp('\\?(' + Object.keys(BUNDLES).join('|') + ')$') }, args => {
        const [path, kind] = args.path.split('?');
        return { path: resolve(args.resolveDir, path), namespace: kind };
      });
      for (const kind of Object.keys(BUNDLES)) context.onLoad({ filter: /.*/, namespace: kind }, args => bundle(args.path, kind));
    },
  };
}
