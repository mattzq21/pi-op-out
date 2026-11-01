import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('fixture cleanup closes its servers and reports only cleanup failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-fixture-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const closed = join(directory, 'closed-');
  const script = join(directory, 'failure.test.mjs');
  await writeFile(script, `
import { test } from 'node:test';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { cleanupScope } from ${JSON.stringify(new URL('../cleanup-scope.mjs', import.meta.url).href)};
for (const failures of [0, 1, 2]) test('cleanup with ' + failures + ' failures', async t => {
  const scope = cleanupScope(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  if (failures > 0) scope.after(async () => { await Promise.resolve(); throw new Error('first cleanup failure'); });
  if (failures === 2) scope.after(() => { throw new Error('second cleanup failure'); });
  scope.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await writeFile(${JSON.stringify(closed)} + failures, 'closed');
  });
});
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', script], { timeout: 5000, env }), error => {
    assert.equal(error.killed, false, 'cleanup must finish without killing the test process');
    assert.equal(error.code, 1, 'cleanup errors must fail the tests');
    assert.match(error.stdout, /^# pass 1$/m);
    assert.match(error.stdout, /^# fail 2$/m);
    assert.match(error.stdout, /first cleanup failure/);
    assert.match(error.stdout, /second cleanup failure/);
    assert.doesNotMatch(error.stdout, /unhandledRejection|asynchronous activity/);
    return true;
  });
  assert.deepEqual(await Promise.all([0, 1, 2].map(count => readFile(closed + count, 'utf8'))), ['closed', 'closed', 'closed']);
});
