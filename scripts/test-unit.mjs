import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeTestExecutable } from '../test/native-file-command.mjs';

// Resolve a fresh Cargo build once, before Node starts the separate test processes.
delete process.env.PIOP_TEST_NATIVE_EXECUTABLE;
delete process.env.PIOP_TEST_DAEMON_EXECUTABLE;
const [executable, daemon] = await Promise.all([
  nativeTestExecutable(),
  promisify(execFile)('bun', ['test/daemon/build.ts']),
]);
const daemonExecutable = daemon.stdout.trim();
if (!daemonExecutable) throw new Error('Daemon test executable was not built');
const child = spawn(process.execPath, [
  '--max-old-space-size=1536', '--enable-source-maps', '--import', './test/register-typescript.mjs',
  '--test', '--test-concurrency=6', '--test-timeout=30000', ...process.argv.slice(2),
], { stdio: 'inherit', env: { ...process.env, PIOP_TEST_NATIVE_EXECUTABLE: executable, PIOP_TEST_DAEMON_EXECUTABLE: daemonExecutable } });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
});
