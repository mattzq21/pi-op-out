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

async function fixture(t, failing, discover) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = Array.from({ length: 5 }, (_, index) => discover ? `test/daemon/${index % 2 ? 'nested/' : ''}case-${index}.test.ts` : join(directory, `case-${index}.test.ts`));
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
  const bun = (await execute('which', ['bun'])).stdout.trim();
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
