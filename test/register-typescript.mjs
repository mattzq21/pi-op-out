import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';

registerHooks({
  load(url, context, nextLoad) {
    const pathname = new URL(url).pathname;

    if (pathname.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };

    if (url.endsWith('?raw')) return { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`, shortCircuit: true };

    if (/\.tsx?$/.test(pathname) && !pathname.includes('/node_modules/')) {
      const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({ MODE: globalThis.__PIOP_TEST_MODE__ ?? "test", DEV: globalThis.__PIOP_TEST_MODE__ === "development" })').replaceAll('import.meta.hot', 'globalThis.__PIOP_TEST_HOT__');
      const result = transformSync(source, { filename: fileURLToPath(url), babelrc: false, configFile: false, presets: [[solid, { generate: 'dom', hydratable: false, delegateEvents: false }], [typescript, { onlyRemoveTypeImports: false }]], sourceMaps: 'inline' });

      return { format: 'module', source: result.code, shortCircuit: true };
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
