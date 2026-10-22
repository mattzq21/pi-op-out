import { execFile, spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const started = performance.now();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { jobs: { type: 'string', default: '3' }, filter: { type: 'string' } },
});
const jobs = Number(values.jobs);
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('--jobs must be a whole number from 1 to 16');
const files = positionals.length ? positionals : (await readdir('test/daemon', { recursive: true })).filter(file => file.endsWith('.test.ts')).sort().map(file => 'test/daemon/' + file);
if (!files.length) throw new Error('No daemon test files found');
if (new Set(files).size !== files.length) throw new Error('Each test file must be listed once');
delete process.env.PIOP_TEST_DAEMON_EXECUTABLE;
const built = await promisify(execFile)('bun', ['test/daemon/build.ts']);
const executable = built.stdout.trim();
if (!executable) throw new Error('Daemon test executable was not built');
const env = { ...process.env, PIOP_TEST_DAEMON_EXECUTABLE: executable };
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
process.exitCode = failed ? 1 : 0;
