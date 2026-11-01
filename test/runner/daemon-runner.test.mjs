import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('a missing selected daemon test is reported before any build starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const builds = join(directory, 'builds');
  await writeFile(join(directory, 'bun'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(builds)}, 'started');
process.exit(73);
`, { mode: 0o755 });
  const missing = join(directory, 'missing.test.ts');
  await assert.rejects(execute(process.execPath,
    [fileURLToPath(new URL('../../scripts/test-daemon.mjs', import.meta.url)), missing],
    { cwd: directory, timeout: 10000, env: { ...process.env, PATH: directory + ':' + process.env.PATH } }), error => {
    assert.match(error.stderr, /ENOENT/);
    assert.ok(error.stderr.includes(missing));
    return error.code === 1;
  });
  assert.equal(existsSync(builds), false, 'invalid selections must not start builds');
});

test('different paths to the same daemon test are rejected before builds start', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-duplicate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'case.test.ts'), '');
  await writeFile(join(directory, 'bun'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
  await assert.rejects(execute(process.execPath,
    [fileURLToPath(new URL('../../scripts/test-daemon.mjs', import.meta.url)),
      './case.test.ts', join(directory, 'case.test.ts')],
    { cwd: directory, timeout: 10000, env: { ...process.env, PATH: directory + ':' + process.env.PATH } }), error => {
    assert.match(error.stderr, /Each test file must be listed once/);
    return error.code === 1;
  });
});

test('all daemon build failures are reported without starting tests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-build-failures-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const selected = join(directory, 'case.test.ts');
  const compiler = join(directory, 'compiler');
  await writeFile(selected, '');
  await writeFile(join(directory, 'bun'), `#!/bin/sh
if [ "$1" = "test/daemon/build.ts" ]; then
  echo 'daemon build failed' >&2
  exit 19
fi
echo 'tests must not start'
`, { mode: 0o755 });
  await writeFile(compiler, "#!/bin/sh\necho 'controls compiler failed' >&2\nexit 23\n", { mode: 0o755 });
  await assert.rejects(execute(process.execPath,
    [fileURLToPath(new URL('../../scripts/test-daemon.mjs', import.meta.url)), selected],
    { cwd: directory, timeout: 10000, env: { ...process.env, PATH: directory + ':' + process.env.PATH, ESBUILD_BINARY_PATH: compiler } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /daemon build failed/);
    assert.match(error.stderr, /controls compiler failed/);
    assert.doesNotMatch(error.stdout, /tests must not start/);
    return true;
  });
});

async function fixture(t, failing, discover) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = Array.from({ length: 3 }, (_, index) => discover ? `test/daemon/${index % 2 ? 'nested/' : ''}case-${index}.test.ts` : join(directory, `case-${index}.test.ts`));
  const builds = join(directory, 'builds'), invocation = join(directory, 'invocation.json');
  const started = [], active = new Set();
  let waiting = [], maximum = 0;
  const server = createServer(socket => {
    let input = '';
    socket.on('close', () => active.delete(socket));
    socket.on('data', chunk => {
      input += chunk;
      if (!input.endsWith('\n')) return;
      started.push(JSON.parse(input));
      active.add(socket);
      maximum = Math.max(maximum, active.size);
      waiting.push(socket);
      if (waiting.length === 2 || started.length === files.length) {
        for (const peer of waiting) { active.delete(peer); peer.end('finish'); }
        waiting = [];
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of active) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await writeFile(join(directory, 'state.mjs'), 'export const state = {};');
  for (const [index, file] of files.entries()) {
    const path = discover ? join(directory, file) : file;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `import { expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { state } from ${JSON.stringify(join(directory, 'state.mjs'))};
test('selected case', async () => {
  expect(process.env.PIOP_RUNNER_STATE).toBeUndefined();
  expect(globalThis.piopRunnerState).toBeUndefined();
  expect(state.value).toBeUndefined();
  process.env.PIOP_RUNNER_STATE = 'changed';
  globalThis.piopRunnerState = true;
  state.value = true;
  await new Promise((resolve, reject) => {
    const socket = createConnection(${server.address().port}, '127.0.0.1', () => {
      socket.write(JSON.stringify({ file: ${JSON.stringify(file)}, executable: process.env.PIOP_TEST_DAEMON_EXECUTABLE, controls: process.env.PIOP_TEST_CONTROLS_BUNDLE, controlsExists: existsSync(process.env.PIOP_TEST_CONTROLS_BUNDLE) }) + '\\n');
    });
    socket.on('error', reject);
    socket.on('data', () => {});
    socket.on('end', resolve);
  });
  expect(${Boolean(failing && index === 1)}).toBe(false);
});
test('ignored case', () => { throw new Error('Filter was not applied'); });
// ${'x'.repeat(index * 500)}
`);
  }
  if (discover) await writeFile(join(directory, 'test/daemon/helper.ts'), '');
  const bun = (await execute('which', ['bun'], { timeout: 10000 })).stdout.trim();
  await writeFile(join(directory, 'bun'), `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2] === 'test/daemon/build.ts') {
  appendFileSync(${JSON.stringify(builds)}, 'build\\n');
  console.log('/fresh/daemon');
} else {
  writeFileSync(${JSON.stringify(invocation)}, JSON.stringify(process.argv.slice(2)));
  const result = spawnSync(${JSON.stringify(bun)}, process.argv.slice(2), { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: directory + ':' + process.env.PATH, PIOP_TEST_DAEMON_EXECUTABLE: '/stale/daemon', PIOP_TEST_CONTROLS_BUNDLE: '/stale/controls' };
  return { directory, files, started, builds, invocation, maximum: () => maximum, run: () => execute(process.execPath,
    [fileURLToPath(new URL('../../scripts/test-daemon.mjs', import.meta.url)), '--jobs', '2', '--filter', 'selected case', ...(discover ? [] : files)],
    { env, cwd: directory, timeout: 10000 }) };
}

for (const [failing, discover] of [[false, false], [true, false], [false, true]]) test(`daemon runner ${discover ? 'discovers nested tests' : failing ? 'reports failure after all files finish' : 'limits concurrency and shares a fresh build'}`, async t => {
  const f = await fixture(t, failing, discover);
  let output;
  if (failing) {
    await assert.rejects(f.run(), error => { output = error.stdout; return error.code === 1 && /1 fail/.test(error.stderr); });
  } else output = (await f.run()).stdout;
  assert.match(output, failing ? /Daemon suite: failed/ : /Daemon suite: passed/);
  assert.deepEqual(f.started.map(item => item.file).sort(), [...f.files].sort());
  if (discover) assert.deepEqual(f.started.slice(0, 2).map(item => item.file).sort(), f.files.slice(-2).sort());
  assert.equal(f.maximum(), 2);
  assert.equal(await readFile(f.builds, 'utf8'), 'build\n');
  assert.equal(existsSync(f.started[0].controls), false);
  assert.equal(existsSync(join(f.directory, 'target/test-cache/daemon-timings.json')), false, 'filtered runs do not replace full-run timings');
  for (const item of f.started) {
    assert.equal(item.executable, '/fresh/daemon');
    assert.equal(item.controlsExists, true);
    assert.notEqual(item.controls, '/stale/controls');
    assert.equal(item.controls, f.started[0].controls);
  }
  const args = JSON.parse(await readFile(f.invocation, 'utf8'));
  assert.deepEqual(args.slice(0, 5), ['test', '--parallel=2', '--parallel-delay=0', '--timeout', '60000']);
  assert.ok(args[5].startsWith('--timings='));
  assert.equal(existsSync(args[5].slice('--timings='.length)), false);
  assert.deepEqual(args.slice(6, 9), ['--update-timings', '-t', 'selected case']);
  assert.deepEqual(args.slice(9).sort(), [...f.files].sort());
});
