import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

registerHooks({
  load(url, context, nextLoad) {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (pathname.endsWith('.tsx')) {
      const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env.MODE', '(globalThis.__PIOP_TEST_MODE__ ?? "test")').replaceAll('import.meta.hot', 'globalThis.__PIOP_TEST_HOT__');
      const result = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, inlineSourceMap: true, inlineSources: true } });
      return { format: 'module', source: result.outputText, shortCircuit: true };
    }
    const result = nextLoad(url, context);
    if (url.endsWith('/src/lib/nativeTransport.ts') || url.endsWith('/src/lib/platform.ts')) {
      return { ...result, source: String(result.source).replaceAll('import.meta.env.MODE', '(globalThis.__PIOP_TEST_MODE__ ?? "test")') };
    }
    return result;
  },
  resolve(specifier, context, nextResolve) {
    if (['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-serialize'].includes(specifier)) return nextResolve(new URL('./terminal-runtime.mjs', import.meta.url).href, context);
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
      try { return nextResolve(`${specifier}.ts`, context); }
      catch (typedError) { if (typedError.code !== 'ERR_MODULE_NOT_FOUND') throw typedError; return nextResolve(`${specifier}.tsx`, context); }
    }
  },
});
