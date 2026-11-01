import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function generatedSource(bundle, file) {
  const marker = bundle.indexOf('"packages/playwright-core/src/generated/' + file + '"() {');
  if (marker < 0) throw new Error('playwright-core no longer bundles ' + file);
  const start = bundle.indexOf("= '", marker) + 2;
  const end = bundle.indexOf("';\n", start + 1);
  return new Function('return ' + bundle.slice(start, end + 1))();
}

const bundle = readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'lib', 'coreBundle.js'), 'utf8');

export const playwrightInternals = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib', 'coreBundle.js'));

export const injectedScriptSource = generatedSource(bundle, 'injectedScriptSource.ts');

export const clockSource = generatedSource(bundle, 'clockSource.ts');
