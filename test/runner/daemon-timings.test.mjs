import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { daemonTestTimings } from '../../scripts/daemon-test-timings.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-test-timings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = [join(directory, 'first.test.ts'), join(directory, 'second.test.ts')];
  await Promise.all(files.map((file, index) => writeFile(file, 'x'.repeat(index + 10))));
  return { files, keys: files.map(file => relative(process.cwd(), file)), working: join(directory, 'run.json'), saved: join(directory, 'saved.json'), directory };
}

const read = async path => JSON.parse(await readFile(path, 'utf8'));

test('unmeasured files use size and measured files retain their durations', async t => {
  const f = await fixture(t);
  await writeFile(f.saved, JSON.stringify({ version: 1, files: { [f.keys[0]]: 0 } }));
  await daemonTestTimings(f.files, f.working, f.saved);
  assert.deepEqual(await read(f.working), { version: 1, files: { [f.keys[0]]: 0, [f.keys[1]]: 11 } });
});

test('saving measurements preserves other files and replaces the cache as one complete file', async t => {
  const f = await fixture(t);
  const save = await daemonTestTimings([f.files[0]], f.working, f.saved);
  await writeFile(f.saved, JSON.stringify({ version: 1, files: { [f.keys[1]]: 700 } }));
  await writeFile(f.working, JSON.stringify({ version: 1, files: { [f.keys[0]]: 250 } }));
  await save();
  assert.deepEqual(await read(f.saved), { version: 1, files: { [f.keys[0]]: 250, [f.keys[1]]: 700 } });
  assert.deepEqual((await readdir(f.directory)).sort(), ['first.test.ts', 'run.json', 'saved.json', 'second.test.ts']);
});

test('damaged timings are reported and cannot omit test files', async t => {
  const f = await fixture(t);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  await writeFile(f.saved, '{broken');
  await daemonTestTimings(f.files, f.working, f.saved);
  assert.deepEqual(await read(f.working), { version: 1, files: { [f.keys[0]]: 10, [f.keys[1]]: 11 } });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(f.saved));
});
