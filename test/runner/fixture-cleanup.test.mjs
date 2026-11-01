import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildTraceControls } from '../trace-command-fixture.mjs';

test('fixture cleanup closes its servers and reports only cleanup failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-fixture-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const closed = join(directory, 'closed-');
  const script = join(directory, 'failure.test.mjs');
  const controls = join(directory, 'controls.mjs');
  const noisyControls = join(directory, 'noisy-controls.mjs');
  const failedControls = join(directory, 'failed-controls.mjs');
  await buildTraceControls(controls);
  await writeFile(noisyControls, `
export { default } from './controls.mjs';
import { writeSync } from 'node:fs';
process.on('exit', () => writeSync(1, 'unexpected publisher output\\n'));
`);
  await writeFile(failedControls, `
export { default } from './controls.mjs';
import { writeSync } from 'node:fs';
process.on('exit', () => { writeSync(2, 'publisher shutdown failed\\n'); process.exitCode = 23; });
`);
  await writeFile(script, `
import { test } from 'node:test';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { cleanupScope } from ${JSON.stringify(new URL('../cleanup-scope.mjs', import.meta.url).href)};
import { chatPublisher } from ${JSON.stringify(new URL('../chat-publisher-fixture.mjs', import.meta.url).href)};
for (const failures of [0, 1, 2]) test('cleanup with ' + failures + ' failures', async t => {
  const scope = cleanupScope(t);
  const order = [];
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  if (failures > 0) scope.after(async () => { await Promise.resolve(); order.push('first'); throw new Error('first cleanup failure'); });
  if (failures === 2) scope.after(() => { order.push('second'); throw new Error('second cleanup failure'); });
  scope.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await writeFile(${JSON.stringify(closed)} + failures, [...order, 'closed'].join(','));
  });
});
for (const [name, controlsBundle] of ${JSON.stringify([['normal output', controls], ['unexpected output', noisyControls], ['failed process', failedControls]])}) test('publisher cleanup with ' + name, async t => {
  const publish = chatPublisher(t, { home: ${JSON.stringify(directory)}, controlsBundle });
  await publish({ content: '' });
});
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', script], { timeout: 5000, env }), error => {
    assert.equal(error.killed, false, 'cleanup must finish without killing the test process');
    assert.equal(error.code, 1, 'cleanup errors must fail the tests');
    assert.match(error.stdout, /^# pass 2$/m);
    assert.match(error.stdout, /^# fail 4$/m);
    assert.match(error.stdout, /first cleanup failure/);
    assert.match(error.stdout, /second cleanup failure/);
    assert.match(error.stdout, /Unexpected chat publisher response/);
    assert.match(error.stdout, /Chat publisher closed \(23\)/);
    assert.match(error.stdout, /publisher shutdown failed/);
    assert.doesNotMatch(error.stdout, /unhandledRejection|asynchronous activity/);
    return true;
  });
  assert.deepEqual(await Promise.all([0, 1, 2].map(count => readFile(closed + count, 'utf8'))), ['closed', 'first,closed', 'first,second,closed']);
});
