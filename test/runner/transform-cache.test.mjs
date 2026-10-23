import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const loader = fileURLToPath(new URL('../register-typescript.mjs', import.meta.url));

test('parallel test processes share complete conversions and source edits invalidate them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-transform-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'value.ts');
  const cache = join(directory, 'cache');
  const run = () => execute(process.execPath, ['--import', loader, '--input-type=module', '-e',
    `import { value } from ${JSON.stringify(pathToFileURL(source).href)}; console.log(value);`],
  { env: { ...process.env, PIOP_TEST_TRANSFORM_CACHE_DIR: cache } });
  await writeFile(source, 'export const value: number = 1;');
  const results = await Promise.all([run(), run(), run()]);
  for (const result of results) assert.equal(result.stdout.trim(), '1');
  const [version] = await readdir(cache);
  const files = await readdir(join(cache, version));
  assert.equal(files.length, 1, 'concurrent writes leave one complete file');
  const cached = await readFile(join(cache, version, files[0]), 'utf8');
  assert.match(cached, /sourceMappingURL/);
  const previous = await stat(join(cache, version, files[0]));
  assert.equal((await run()).stdout.trim(), '1');
  assert.equal((await stat(join(cache, version, files[0]))).mtimeMs, previous.mtimeMs, 'cache hits do not rewrite the conversion');
  assert.deepEqual(await readdir(join(cache, version)), files, 'unchanged source reuses its cache entry');
  await writeFile(source, 'export const value: number = 2;');
  assert.equal((await run()).stdout.trim(), '2');
  assert.equal((await readdir(join(cache, version))).length, 2);
  await writeFile(source, 'export const value: number = ;');
  await assert.rejects(run(), /Unexpected token/);
  assert.equal((await readdir(join(cache, version))).length, 2, 'failed conversions are not cached');
});

test('different compiler settings never share cached output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-transform-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = new URL('../transform-cache.mjs', import.meta.url).href;
  const source = join(directory, 'component.tsx');
  const implementation = join(directory, 'compiler.mjs');
  const cache = join(directory, 'cache');
  const run = () => execute(process.execPath, ['--input-type=module', '-e',
    `import { cachedTransform } from ${JSON.stringify(helper)};
     import { readFileSync } from 'node:fs';
     const implementation = new URL(${JSON.stringify(pathToFileURL(implementation).href)});
     const convert = cachedTransform(implementation, text => readFileSync(implementation, 'utf8') + text);
     console.log(convert('source', ${JSON.stringify(source)}));`],
  { env: { ...process.env, PIOP_TEST_TRANSFORM_CACHE_DIR: cache } });
  await writeFile(implementation, 'browser:');
  assert.equal((await run()).stdout.trim(), 'browser:source');
  await writeFile(implementation, 'node:');
  assert.equal((await run()).stdout.trim(), 'node:source');
  await writeFile(implementation, 'browser:');
  assert.equal((await run()).stdout.trim(), 'browser:source');
  assert.equal((await readdir(cache)).length, 2);
});
