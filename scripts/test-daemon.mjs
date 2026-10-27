import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { daemonTestTimings } from './daemon-test-timings.mjs';

const started = performance.now();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { jobs: { type: 'string', default: '4' }, filter: { type: 'string' } },
});
const jobs = Number(values.jobs);
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('--jobs must be a whole number from 1 to 16');
const files = positionals.length ? positionals : (await readdir('test/daemon', { recursive: true })).filter(file => file.endsWith('.test.ts')).sort().map(file => 'test/daemon/' + file);
if (!files.length) throw new Error('No daemon test files found');
if (new Set(files).size !== files.length) throw new Error('Each test file must be listed once');

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'piop-daemon-builds-'));
  try {
    delete process.env.PIOP_TEST_DAEMON_EXECUTABLE;
    delete process.env.PIOP_TEST_CONTROLS_BUNDLE;
    const controlsBundle = join(directory, 'controls.mjs');
    const source = `import { buildTraceControls } from ${JSON.stringify(new URL('../test/trace-command-fixture.mjs', import.meta.url).href)}; await buildTraceControls(process.argv[1]);`;
    const builds = await Promise.allSettled([
      promisify(execFile)('bun', ['test/daemon/build.ts']),
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, controlsBundle]),
    ]);
    const failedBuild = builds.find(result => result.status === 'rejected');
    if (failedBuild) throw failedBuild.reason;
    const executable = builds[0].value.stdout.trim();
    if (!executable) throw new Error('Daemon test executable was not built');
    const env = { ...process.env, PIOP_TEST_DAEMON_EXECUTABLE: executable, PIOP_TEST_CONTROLS_BUNDLE: controlsBundle };
    const timings = join(directory, 'timings.json');
    const saveTimings = await daemonTestTimings(files, timings, 'target/test-cache/daemon-timings.json');
    const result = await new Promise((resolve, reject) => {
      const child = spawn('bun', ['test', '--parallel=' + jobs, '--parallel-delay=0', '--timeout', '60000',
        '--timings=' + timings, '--update-timings', ...(values.filter ? ['-t', values.filter] : []), ...files], { env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) throw new Error('Daemon tests stopped by ' + result.signal);
    if (result.code === 0 && !values.filter) await saveTimings();
    console.log(`Daemon suite: ${result.code === 0 ? 'passed' : 'failed'}. Time: ${((performance.now() - started) / 1000).toFixed(2)}s.`);
    return result.code ?? 1;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

process.exitCode = await main();
