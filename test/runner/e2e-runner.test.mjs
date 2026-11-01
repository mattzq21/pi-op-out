import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../../scripts/test-e2e.mjs', import.meta.url));

test('an unmatched E2E selection is reported before building the app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-e2e-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const specs = join(directory, 'test/e2e/specs');
  await mkdir(specs, { recursive: true });
  await writeFile(join(specs, 'conversation.acceptance.spec.ts'), "describe('chat', () => { it('opens', () => {}); });");
  const builds = join(directory, 'builds');
  await writeFile(join(directory, 'bun'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(builds)}, 'started');
process.exit(73);
`, { mode: 0o755 });
  await assert.rejects(execute(process.execPath, [runner, '--build', '--list', '--grep', '^missing$'],
    { cwd: directory, timeout: 10000, env: { ...process.env, PATH: directory + ':' + process.env.PATH } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No E2E tests matched/);
    return true;
  });
  assert.equal(existsSync(builds), false, 'unmatched selections must not start builds');
});

test('E2E listing selects imported cases by their full nested names', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-e2e-list-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const specs = join(directory, 'test/e2e/specs');
  await mkdir(specs, { recursive: true });
  await writeFile(join(specs, 'conversation.acceptance.spec.ts'), "import './drafts.cases.js';");
  await writeFile(join(specs, 'drafts.cases.ts'), `
describe('Session tree', () => {
  describe('Drafts', () => { it('keeps text', () => {}); });
  it('opens a session', () => {});
});
`);
  const result = await execute(process.execPath, [runner, '--list', '--grep', '^Session tree Drafts '], { cwd: directory, timeout: 10000 });
  assert.equal(result.stdout, 'Session tree Drafts keeps text\n');
});

for (const failing of [false, true]) test(failing
  ? 'a failed E2E batch does not omit or repeat selected tests'
  : 'successful E2E batches run each selected test once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-e2e-batches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const specs = join(directory, 'test/e2e/specs');
  const command = join(directory, 'node_modules/@wdio/cli/bin');
  await Promise.all([mkdir(specs, { recursive: true }), mkdir(command, { recursive: true })]);
  const selected = ['chat case [draft]?', ...Array.from({ length: 10 }, (_, index) => `chat case ${index}`)];
  const titles = [...selected, 'chat omitted'];
  await writeFile(join(specs, 'conversation.acceptance.spec.ts'),
    titles.map(title => `it(${JSON.stringify(title)}, () => {});`).join('\n'));
  await writeFile(join(command, 'wdio.js'), `
const pattern = new RegExp(process.argv[process.argv.indexOf('--mochaOpts.grep') + 1]);
const selected = ${JSON.stringify(titles)}.filter(title => pattern.test(title));
console.log(JSON.stringify(selected));
process.exitCode = ${failing} && selected.includes('chat case [draft]?') ? 1 : 0;
`);
  const run = () => execute(process.execPath, [runner, '--grep', '^chat case'], { cwd: directory, timeout: 10000 });
  let output;
  if (failing) {
    await assert.rejects(run(), error => {
      assert.equal(error.code, 1);
      output = error.stdout;
      return true;
    });
  } else output = (await run()).stdout;
  const batches = output.split('\n').filter(line => line.startsWith('[')).map(line => JSON.parse(line));
  assert.deepEqual(batches.flat(), selected);
  assert.deepEqual(batches.map(batch => batch.length), [10, 1]);
});
