import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../../scripts/test-unit.mjs', import.meta.url));
const helper = new URL('../native-file-command.mjs', import.meta.url).href;

async function fixture(t, fail) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-native-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'builds');
  const binary = join(directory, 'native-test');
  await writeFile(join(directory, 'cargo'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, 'build\\n');
${fail === 'native' ? "console.error('build failed'); process.exit(17);" : `console.log(JSON.stringify({executable: ${JSON.stringify(binary)}, target: {name: 'piop_desktop'}}));`}
`, { mode: 0o755 });
  const daemonBinary = join(directory, 'daemon-test');
  await writeFile(join(directory, 'bun'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, 'daemon\\n');
${fail === 'daemon' ? "console.error('daemon build failed'); process.exit(19);" : `console.log(${JSON.stringify(daemonBinary)});`}
`, { mode: 0o755 });
  const files = [];
  for (let index = 0; index < 3; index++) {
    const file = join(directory, `child-${index}.test.mjs`);
    await writeFile(file, `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeTestExecutable } from ${JSON.stringify(helper)};
test('child ${index} uses this run\\'s build', async () => {
  assert.equal(await nativeTestExecutable(), ${JSON.stringify(binary)});
  assert.equal(process.env.PIOP_TEST_DAEMON_EXECUTABLE, ${JSON.stringify(daemonBinary)});
});`);
    files.push(file);
  }
  const env = { ...process.env, PATH: directory + ':' + process.env.PATH, PIOP_TEST_NATIVE_EXECUTABLE: '/stale/previous-build', PIOP_TEST_DAEMON_EXECUTABLE: '/stale/daemon' };
  delete env.NODE_TEST_CONTEXT;
  const run = () => execute(process.execPath, [runner, ...files], { env });
  return { run, log };
}

test('fresh native and daemon builds are shared by separate test processes', async t => {
  const { run, log } = await fixture(t);
  const result = await run();
  assert.match(result.stdout, /pass 3/);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').sort(), ['build', 'daemon']);
});

for (const target of ['native', 'daemon']) test(`a ${target} build failure prevents the tests from starting`, async t => {
  const { run } = await fixture(t, target);
  await assert.rejects(run(), error => {
    assert.match(error.stderr, /build failed/);
    assert.doesNotMatch(error.stdout, /child [0-9]/);
    return true;
  });
});
