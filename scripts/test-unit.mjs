import { spawn } from 'node:child_process';
import { nativeTestExecutable } from '../test/native-file-command.mjs';

// Resolve a fresh Cargo build once, before Node starts the separate test processes.
delete process.env.PIOP_TEST_NATIVE_EXECUTABLE;
const executable = await nativeTestExecutable();
const child = spawn(process.execPath, [
  '--max-old-space-size=1536', '--enable-source-maps', '--import', './test/register-typescript.mjs',
  '--test', '--test-concurrency=6', '--test-timeout=30000', ...process.argv.slice(2),
], { stdio: 'inherit', env: { ...process.env, PIOP_TEST_NATIVE_EXECUTABLE: executable } });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
});
