import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nativeTestExecutable } from '../test/native-file-command.mjs';
import { buildTraceControls } from '../test/trace-command-fixture.mjs';

// Resolve fresh builds once, before Node starts the separate test processes.
delete process.env.PIOP_TEST_NATIVE_EXECUTABLE;
delete process.env.PIOP_TEST_DAEMON_EXECUTABLE;
delete process.env.PIOP_TEST_CONTROLS_BUNDLE;

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'piop-unit-builds-'));
  const controlsBundle = join(directory, 'controls.mjs');
  try {
    const builds = await Promise.allSettled([
      nativeTestExecutable(),
      promisify(execFile)('bun', ['test/daemon/build.ts']),
      buildTraceControls(controlsBundle),
    ]);
    const failed = builds.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const executable = builds[0].value;
    const daemonExecutable = builds[1].value.stdout.trim();
    if (!daemonExecutable) throw new Error('Daemon test executable was not built');
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--max-old-space-size=1536', '--enable-source-maps', '--import', './test/register-typescript.mjs',
        '--test', '--test-concurrency=6', '--test-timeout=30000', ...process.argv.slice(2),
      ], { stdio: 'inherit', env: { ...process.env, PIOP_TEST_NATIVE_EXECUTABLE: executable, PIOP_TEST_DAEMON_EXECUTABLE: daemonExecutable, PIOP_TEST_CONTROLS_BUNDLE: controlsBundle } });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const { code, signal } = await run();
if (signal) process.kill(process.pid, signal);
else process.exitCode = code;
