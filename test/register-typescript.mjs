import { createRequire, registerHooks } from 'node:module';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let compiler, cacheDirectory;

function converted(source, filename) {
  const root = process.env.PIOP_TEST_TRANSFORM_CACHE_DIR;
  if (!root) return transform(source, filename).code;
  if (!cacheDirectory) {
    const version = createHash('sha256').update(readFileSync(new URL('./register-typescript.mjs', import.meta.url)))
      .update(readFileSync(new URL('../bun.lock', import.meta.url))).update(process.version).digest('hex');
    cacheDirectory = join(root, version);
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  }
  const key = createHash('sha256').update(filename).update('\0').update(source).digest('hex');
  const target = join(cacheDirectory, key + '.js');
  try { return readFileSync(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const code = transform(source, filename).code;
  const temporary = target + '.' + randomUUID();
  try {
    writeFileSync(temporary, code, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return code;
}

function transform(source, filename) {
  compiler ??= {
    transformSync: require('@babel/core').transformSync,
    solid: require('babel-preset-solid'),
    typescript: require('@babel/preset-typescript').default,
  };
  return compiler.transformSync(source, { filename, babelrc: false, configFile: false, presets: [[compiler.solid, { generate: 'dom', hydratable: false, delegateEvents: false }], [compiler.typescript, { onlyRemoveTypeImports: false }]], sourceMaps: 'inline' });
}

registerHooks({
  load(url, context, nextLoad) {
    const pathname = new URL(url).pathname;

    if (pathname.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };

    if (url.endsWith('?raw')) return { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`, shortCircuit: true };

    if (/\.tsx?$/.test(pathname) && !pathname.includes('/node_modules/')) {
      const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({ MODE: globalThis.__PIOP_TEST_MODE__ ?? "test", DEV: globalThis.__PIOP_TEST_MODE__ === "development" })').replaceAll('import.meta.hot', 'globalThis.__PIOP_TEST_HOT__');
      const code = converted(source, fileURLToPath(url));

      return { format: 'module', source: code, shortCircuit: true };
    }

    const result = nextLoad(url, context);

    if (url.endsWith('/clients/ui/lib/nativeTransport.ts') || url.endsWith('/clients/ui/lib/platform.ts')) {
      return { ...result, source: String(result.source).replaceAll('import.meta.env.MODE', '(globalThis.__PIOP_TEST_MODE__ ?? "test")') };
    }

    return result;
  },
  resolve(specifier, context, nextResolve) {
    if (specifier === 'solid-js' || specifier.startsWith('solid-js/')) return nextResolve(specifier, { ...context, conditions: [...context.conditions.filter(condition => condition !== 'node'), 'browser'] });

    if (['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-serialize'].includes(specifier)) return nextResolve(new URL('./terminal-runtime.mjs', import.meta.url).href, context);

    try { return nextResolve(specifier, context); }
    catch (error) {
      if (!['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code) || !specifier.startsWith('.')) throw error;

      if (error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return nextResolve(`${specifier.replace(/\/$/, '')}/index.ts`, context);

      try { return nextResolve(`${specifier}.ts`, context); }
      catch (typedError) { if (typedError.code !== 'ERR_MODULE_NOT_FOUND') throw typedError;

      return nextResolve(`${specifier}.tsx`, context); }
    }
  },
});
