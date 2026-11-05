import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '../..');

// A worker thread names each database change, and the main thread runs it. The main thread knows a change only if it
// loaded its module, so every module that names one must be loaded at start.
test('the daemon main thread loads every module whose database changes worker threads ask for', () => {
  const loaded = readFileSync(join(root, 'daemon/src/host_operations/main_thread_changes.ts'), 'utf8');
  const naming = [...new Glob('daemon/resources/**/*.{cjs,mjs,ts}').scanSync(root)]
    .filter(file => !file.includes('main-thread.') && readFileSync(join(root, file), 'utf8').includes('onMainThread('));
  expect(naming.length).toBeGreaterThan(0);
  expect(naming.filter(file => !loaded.includes(`import '${relative(join(root, 'daemon/src/host_operations'), join(root, file))}';`))).toEqual([]);
});
