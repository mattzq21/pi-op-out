import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { cachedTransform } from '../transform-cache.mjs';

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

test('cached conversions report errors against the correct source file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-transform-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, 'first.ts');
  const second = join(directory, 'second.ts');
  const source = "type Value = number;\n\nconst value: Value = 1;\nthrow new Error('conversion failed');\n";
  await Promise.all([writeFile(first, source), writeFile(second, source)]);
  await assert.rejects(execute(process.execPath,
    ['--enable-source-maps', '--import', loader, '--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(first).href)}).catch(() => {});
       await import(${JSON.stringify(pathToFileURL(second).href)});`],
    { timeout: 10000, env: { ...process.env, PIOP_TEST_TRANSFORM_CACHE_DIR: join(directory, 'cache') } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /conversion failed/);
    assert.ok(error.stderr.includes(second + ':4'));
    assert.ok(!error.stderr.includes(first));
    return true;
  });
});

test('different compiler settings never share cached output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-transform-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'component.tsx');
  const implementation = join(directory, 'compiler.mjs');
  const cache = join(directory, 'cache');
  const previous = process.env.PIOP_TEST_TRANSFORM_CACHE_DIR;
  process.env.PIOP_TEST_TRANSFORM_CACHE_DIR = cache;
  t.after(() => {
    if (previous === undefined) delete process.env.PIOP_TEST_TRANSFORM_CACHE_DIR;
    else process.env.PIOP_TEST_TRANSFORM_CACHE_DIR = previous;
  });
  const run = () => cachedTransform(pathToFileURL(implementation),
    text => readFileSync(implementation, 'utf8') + text)('source', source);
  await writeFile(implementation, 'browser:');
  assert.equal(run(), 'browser:source');
  await writeFile(implementation, 'node:');
  assert.equal(run(), 'node:source');
  await writeFile(implementation, 'browser:');
  assert.equal(run(), 'browser:source');
  assert.equal((await readdir(cache)).length, 2);
});
