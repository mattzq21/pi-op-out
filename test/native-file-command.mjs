import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

let executable;
export function nativeTestExecutable() {
  if (process.env.PIOP_TEST_NATIVE_EXECUTABLE) return Promise.resolve(process.env.PIOP_TEST_NATIVE_EXECUTABLE);
  return executable ??= promisify(execFile)('cargo', ['test', '--locked', '-p', 'piop-desktop', '--lib', '--no-run', '--message-format=json'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, TAURI_CONFIG: '{"bundle":{"externalBin":[]}}' }, maxBuffer: 32 * 1024 * 1024,
  }).then(({ stdout }) => {
    const artifact = stdout.trim().split('\n').map(line => JSON.parse(line)).find(value => value.executable && value.target?.name === 'piop_desktop');
    if (!artifact) throw new Error('Desktop test executable was not built');
    return artifact.executable;
  });
}

export async function nativeFileCommand(t, { launcher, desktop = false, desktopUrl, env = {}, bundledDaemon } = {}) {
  let binary = await nativeTestExecutable();
  const directory = await mkdtemp(join(tmpdir(), 'piop-native-file-'));
  if (bundledDaemon) {
    try {
      const isolatedBinary = join(directory, 'piop-test');
      await copyFile(binary, isolatedBinary);
      await copyFile(bundledDaemon, join(directory, 'piopd'));
      binary = isolatedBinary;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  const launchLog = join(directory, 'launches.txt');
  const launcherEnv = {};
  if (launcher) {
    await writeFile(join(directory, 'xdg-open'), "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$PIOP_TEST_LAUNCH_LOG\"\nexit \"$PIOP_TEST_LAUNCH_STATUS\"\n", { mode: 0o755 });
    Object.assign(launcherEnv, { PATH: directory + ':' + process.env.PATH, PIOP_TEST_LAUNCH_LOG: launchLog, PIOP_TEST_LAUNCH_STATUS: String(launcher.status ?? 0) });
  }
  const path = join(directory, 'command.sock');
  const child = spawn(binary, ['tests::attachment_command_bridge', '--exact', '--ignored', '--nocapture'], {
    env: { ...process.env, ...launcherEnv, ...(desktop ? { HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory, PIOP_TEST_NATIVE_APP: '1', ...(desktopUrl ? { PIOP_TEST_NATIVE_URL: desktopUrl } : {}) } : {}), ...env, PIOP_TEST_NATIVE_SOCKET: path }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '', socket;
  child.stderr.on('data', data => { diagnostics += data; });
  const ended = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(async () => {
    if (socket) socket.end(); else child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const code = await ended;
      if (socket && code !== 0) throw new Error(`Native test bridge exited with ${code}: ${diagnostics}`);
    } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
  });
  await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error(`Native test bridge did not start: ${diagnostics}`)), 10000);
    child.once('error', reject);
    ended.then(code => { clearTimeout(timer); reject(new Error(`Native test bridge exited before readiness (${code}): ${diagnostics}`)); });
    lines.on('line', line => {
      if (line === 'PIOP_TEST_NATIVE_READY') { clearTimeout(timer); resolve(); }
    });
  });
  socket = createConnection(path);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  createInterface({ input: socket }).on('line', line => {
    const response = JSON.parse(line), request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error !== undefined) request.reject(new Error(response.error)); else request.resolve(response.result);
  });
  const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  socket.on('error', fail); socket.on('close', () => fail(new Error('Native test bridge closed')));
  return {
    directory,
    async launchedTargets() {
      try { return (await readFile(launchLog, 'utf8')).trimEnd().split('\n'); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    invoke(command, args) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(JSON.stringify({ ...args, id, command }) + '\n');
      });
    },
  };
}
