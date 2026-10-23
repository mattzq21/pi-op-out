import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function fixture(t, failing = false, discover = false) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = Array.from({ length: 5 }, (_, index) => discover ? `test/daemon/${index % 2 ? 'nested/' : ''}case-${index}.test.ts` : join(directory, `case-${index}.test.ts`));
  if (discover) {
    for (const file of files) { const path = join(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'x'.repeat(files.indexOf(file) + 1)); }
    await writeFile(join(directory, 'test/daemon/helper.ts'), '');
  }
  const builds = join(directory, 'builds');
  const started = [];
  let waiting = [];
  let active = 0;
  let maximum = 0;
  let runnerPid;
  const childCounts = [];
  const server = createServer(socket => {
    let input = '';
    socket.on('close', () => { active--; });
    socket.on('data', chunk => {
      input += chunk;
      if (!input.endsWith('\n')) return;
      const item = JSON.parse(input);
      started.push(item);
      active++;
      maximum = Math.max(maximum, active);
      waiting.push(socket);
      if (waiting.length === 2 || started.length === files.length) {
        childCounts.push(readFileSync(`/proc/${runnerPid}/task/${runnerPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).length);
        for (const peer of waiting) peer.end('finish');
        waiting = [];
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of waiting) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await writeFile(join(directory, 'bun'), `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
if (process.argv[2] === 'test/daemon/build.ts') {
  appendFileSync(${JSON.stringify(builds)}, 'build\\n');
  console.log('/fresh/daemon');
} else {
  const socket = createConnection(${server.address().port}, '127.0.0.1', () => {
    socket.write(JSON.stringify({ file: process.argv.at(-1), args: process.argv.slice(2), executable: process.env.PIOP_TEST_DAEMON_EXECUTABLE, controls: process.env.PIOP_TEST_CONTROLS_BUNDLE, controlsExists: existsSync(process.env.PIOP_TEST_CONTROLS_BUNDLE ?? '') }) + '\\n');
  });
  socket.on('data', () => {
    console.log('finished ' + process.argv.at(-1));
    process.exitCode = ${failing ? `process.argv.at(-1) === ${JSON.stringify(files[1])} ? 7 : 0` : '0'};
  });
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: directory + ':' + process.env.PATH, PIOP_TEST_DAEMON_EXECUTABLE: '/stale/daemon', PIOP_TEST_CONTROLS_BUNDLE: '/stale/controls' };
  return { files, started, builds, childCounts, maximum: () => maximum, run: () => {
    const pending = execute(process.execPath, [fileURLToPath(new URL('../../scripts/test-daemon.mjs', import.meta.url)), '--jobs', '2', '--filter', 'selected case', ...(discover ? [] : files)], { env, cwd: discover ? directory : process.cwd(), timeout: 10000 });
    runnerPid = pending.child.pid;
    return pending;
  } };
}

for (const [failing, discover] of [[false, false], [true, false], [false, true]]) test(`daemon runner ${discover ? 'discovers nested tests' : failing ? 'reports failure after all files finish' : 'limits concurrency and shares a fresh build'}`, async t => {
  const f = await fixture(t, failing, discover);
  let output;
  if (failing) {
    await assert.rejects(f.run(), error => { output = error.stdout; return error.code === 1 && /exited with 7/.test(error.stderr); });
  } else output = (await f.run()).stdout;
  assert.match(output, failing ? /4 passed, 1 failed/ : /5 passed, 0 failed/);
  assert.deepEqual(f.started.map(item => item.file).sort(), [...f.files].sort());
  if (discover) assert.deepEqual(f.started.slice(0, 2).map(item => item.file).sort(), f.files.slice(-2).sort());
  assert.equal(f.maximum(), 2);
  assert.ok(f.childCounts.every(count => count <= 2));
  assert.equal(f.childCounts[0], 2);
  assert.equal(await readFile(f.builds, 'utf8'), 'build\n');
  assert.equal(existsSync(f.started[0].controls), false);
  for (const item of f.started) {
    assert.equal(item.executable, '/fresh/daemon');
    assert.equal(item.controlsExists, true);
    assert.notEqual(item.controls, '/stale/controls');
    assert.equal(item.controls, f.started[0].controls);
    assert.deepEqual(item.args.slice(0, -1), ['test', '--timeout', '60000', '-t', 'selected case']);
  }
});
