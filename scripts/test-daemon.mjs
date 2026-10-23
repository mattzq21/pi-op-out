import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const started = performance.now();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { jobs: { type: 'string', default: '4' }, filter: { type: 'string' } },
});
const jobs = Number(values.jobs);
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('--jobs must be a whole number from 1 to 16');
const files = positionals.length ? positionals : (await readdir('test/daemon', { recursive: true })).filter(file => file.endsWith('.test.ts')).sort().map(file => 'test/daemon/' + file);
if (!positionals.length) {
  const sizes = new Map(await Promise.all(files.map(async file => [file, (await stat(file)).size])));
  files.sort((a, b) => sizes.get(b) - sizes.get(a) || a.localeCompare(b));
}
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
    let next = 0;
    let failed = 0;

    async function run(file) {
      return await new Promise(resolve => {
        let output = '';
        const child = spawn('bun', ['test', '--timeout', '60000', ...(values.filter ? ['-t', values.filter] : []), file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', error => { output += error.stack + '\n'; });
        child.on('close', (code, signal) => {
          process.stdout.write(output);
          if (code !== 0) {
            failed++;
            process.stderr.write(`${file}: ${signal ? 'stopped by ' + signal : 'exited with ' + code}\n`);
          }
          resolve();
        });
      });
    }

    await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
      while (next < files.length) await run(files[next++]);
    }));
    console.log(`Daemon files: ${files.length - failed} passed, ${failed} failed. Time: ${((performance.now() - started) / 1000).toFixed(2)}s.`);
    return failed ? 1 : 0;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

process.exitCode = await main();
