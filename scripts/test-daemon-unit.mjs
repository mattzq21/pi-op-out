import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

// Runs the daemon unit tests: the tests in test/daemon/unit/, which start no daemon, no Host and no Pi, so nothing is
// built first. The test fixtures refuse to start them while PIOP_TEST_DAEMON_UNIT is set.
const started = performance.now();
const given = process.argv.slice(2);
const files = given.length ? given : (await readdir('test/daemon/unit')).filter(file => file.endsWith('.test.ts')).sort().map(file => 'test/daemon/unit/' + file);
if (!files.length) throw new Error('No daemon unit test files found');
const outside = files.filter(file => !file.replace(/^\.\//, '').startsWith('test/daemon/unit/'));
if (outside.length) throw new Error('Not daemon unit tests: ' + outside.join(', '));

const result = await new Promise((resolve, reject) => {
  const child = spawn('bun', ['test', '--preload', './test/daemon/typebox-preload.cjs', '--timeout', '60000', ...files],
    { env: { ...process.env, PIOP_TEST_DAEMON_UNIT: '1' }, stdio: 'inherit' });
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
if (result.signal) throw new Error('Daemon unit tests stopped by ' + result.signal);
console.log(`Daemon unit tests: ${result.code === 0 ? 'passed' : 'failed'}. Time: ${((performance.now() - started) / 1000).toFixed(2)}s.`);
process.exitCode = result.code ?? 1;
