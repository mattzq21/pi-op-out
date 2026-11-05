import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAsync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { SHARED_MODULES, SHARED_MODULES_KEY } from '../protocol/plugins.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

// Pi loads its extensions through jiti. jiti maps these imports to Pi's own copies and gives each file `require`.
const PI_PROVIDED = ['@earendil-works/*', 'typebox', 'typebox/*'];

// A plugin's client part gets these modules from the app, so it uses the app's copies.
const sharedModules = {
  name: 'piop-shared-modules',
  setup(context) {
    const names = new Set(SHARED_MODULES);
    context.onResolve({ filter: /.*/ }, args => names.has(args.path) ? { path: args.path, namespace: 'piop-shared' } : undefined);
    context.onLoad({ filter: /.*/, namespace: 'piop-shared' }, args => ({
      contents: `module.exports = globalThis[Symbol.for(${JSON.stringify(SHARED_MODULES_KEY)})][${JSON.stringify(args.path)}];`, loader: 'js',
    }));
  },
};

const solidJsx = {
  name: 'solid-jsx',
  setup(context) {
    context.onLoad({ filter: /\.[jt]sx$/ }, async args => {
      const result = await transformAsync(await readFile(args.path, 'utf8'), {
        filename: args.path, babelrc: false, configFile: false,
        presets: [[solid, { generate: 'dom' }], [typescript, { onlyRemoveTypeImports: false }]],
      });
      return { contents: result.code, loader: 'js' };
    });
  },
};

const BUNDLES = {
  'pi-extension': () => ({ format: 'esm', external: PI_PROVIDED }),
  // The app imports this file; see clients/ui/plugins/clientModules.ts.
  'plugin-client': () => ({ format: 'esm', platform: 'browser', target: 'es2022', plugins: [sharedModules, solidJsx] }),
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
// - `piop-builtin-plugins` gives each folder in plugins/: its plugin.json, and its extension and client part built.
export function daemonImports() {
  return {
    name: 'daemon-imports',
    setup(context) {
      context.onResolve({ filter: /^piop-builtin-plugins$/ }, () => ({ path: join(root, 'plugins'), namespace: 'builtin-plugins' }));
      context.onLoad({ filter: /.*/, namespace: 'builtin-plugins' }, args => builtInPlugins(args.path));
      context.onResolve({ filter: /^piop-agent-loader$/ }, () => ({ path: join(root, 'pi-extensions/piop-define-agents/daemon-loader.ts') }));
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

function builtInPlugins(folder) {
  const ids = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const imports = [];
  const items = ids.map((id, index) => {
    const part = (name, file, kind) => {
      const path = join(folder, id, file);
      if (!existsSync(path)) return '';
      imports.push(`import ${name}${index} from ${JSON.stringify(path + '?' + kind)};`);
      return `, ${name}: ${name}${index}`;
    };
    return `{ manifest: manifest${index}` + part('extension', 'extension/index.ts', 'pi-extension') + part('client', 'client/index.tsx', 'plugin-client') + ' }';
  });
  ids.forEach((id, index) => imports.push(`import manifest${index} from ${JSON.stringify(join(folder, id, 'plugin.json') + '?raw')};`));
  return { contents: imports.join('\n') + `\nexport default [${items.join(', ')}];\n`, loader: 'js', resolveDir: folder, watchDirs: [folder, ...ids.map(id => join(folder, id))] };
}

// The client part of a built-in plugin, built as the daemon builds it.
export async function pluginClientSource(id) {
  return (await bundle(join(root, 'plugins', id, 'client/index.tsx'), 'plugin-client')).contents;
}
