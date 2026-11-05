import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');

// A worker thread names each database change, and the main thread runs it. The main thread knows a change only if it
// loaded its module, so every module that names one must be loaded at start.
test('the daemon main thread loads every module whose database changes worker threads ask for', async () => {
  const named = ['daemon', 'pi-extensions', 'plugins'].flatMap(folder => [...new Glob(folder + '/**/*.{cjs,mjs,ts}').scanSync(root)])
    .filter(file => !file.includes('node_modules') && !file.endsWith('main-thread.ts'))
    .flatMap(file => [...readFileSync(join(root, file), 'utf8').matchAll(/onMainThread\(\s*(['"])([^'"]+)\1/g)].map(match => match[2]));
  expect(named.length).toBeGreaterThan(0);
  await import('../../../daemon/src/host_operations/main_thread_changes.ts');
  const loaded = (globalThis as any)[Symbol.for('piop.main-thread-operations')] as Map<string, unknown>;
  expect(named.filter(name => !loaded.has(name))).toEqual([]);
});
