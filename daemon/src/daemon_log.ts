import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import * as endpoint from './daemon_endpoint';
import { daemonScript } from './session_worker';
import { lockPathSync } from './util/flock';
import { sleep } from './util/sync';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BACKUP_COUNT = 4;
const READY = 1;
const CAPTURED = 'PIOP_DAEMON_LOG_CAPTURED';
const LOGGED_MODES = ['--serve', '--exit-on-disconnect', '--restart-candidate', '--restart-coordinator', '--validate-plugins'];

/** A child process description for daemon processes that write to daemon.log. */
export interface DaemonCommand { program: string; args: string[]; env: Record<string, string | undefined>; stderr?: any }

function privateFile(path: string, flags: string): number {
  const fd = openSync(path, flags, 0o600);
  try { setPrivateFilePermissions(path); } catch (error) { closeSync(fd); throw error; }
  return fd;
}

function withLock<T>(directory: string, operation: () => T): T {
  const first = lockPathSync(join(directory, 'daemon-log.lock'));
  try {
    setPrivateFilePermissions(join(directory, 'daemon-log.lock'));
    const second = lockPathSync(join(directory, 'daemon.log.lock'));
    try { return operation(); } finally { second.release(); }
  } finally { first.release(); }
}

function archivePath(directory: string, index: number): string { return join(directory, 'daemon.log.' + index); }

function removeIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

function rotate(directory: string): void {
  removeIfPresent(archivePath(directory, BACKUP_COUNT));
  for (let index = BACKUP_COUNT - 1; index >= 1; index -= 1) {
    try { renameSync(archivePath(directory, index), archivePath(directory, index + 1)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  renameSync(join(directory, 'daemon.log'), archivePath(directory, 1));
}

function trimLegacyLog(directory: string): void {
  const path = join(directory, 'daemon.log');
  const temporary = join(directory, 'daemon.log.trim');
  removeIfPresent(temporary);
  const source = privateFile(path, 'a+');
  try {
    const size = fstatSync(source).size;
    if (size <= MAX_FILE_BYTES) return;
    const buffer = Buffer.alloc(MAX_FILE_BYTES);
    let read = 0;
    while (read < MAX_FILE_BYTES) {
      const count = readSync(source, buffer, read, MAX_FILE_BYTES - read, size - MAX_FILE_BYTES + read);
      if (count === 0) break;
      read += count;
    }
    try {
      const target = privateFile(temporary, 'w');
      try { ftruncateSync(target, 0); writeSync(target, buffer, 0, read); fsyncSync(target); } finally { closeSync(target); }
      renameSync(temporary, path);
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  } finally { closeSync(source); }
}

function append(directory: string, data: Buffer): Buffer {
  return withLock(directory, () => {
    let pending = data;
    while (pending.length) {
      const fd = privateFile(join(directory, 'daemon.log'), 'a');
      try {
        const length = fstatSync(fd).size;
        if (length >= MAX_FILE_BYTES) { closeSync(fd); rotate(directory); continue; }
        const count = Math.min(pending.length, MAX_FILE_BYTES - length);
        const written = writeSync(fd, pending, 0, count);
        if (written === 0) throw new Error('Could not write daemon diagnostics');
        pending = pending.subarray(written);
      } finally { try { closeSync(fd); } catch {} }
    }
    return pending;
  });
}

function collect(directory: string): Promise<void> {
  return new Promise(resolve => {
    let queue = Promise.resolve();
    process.stdin.on('data', (chunk: Buffer) => {
      queue = queue.then(async () => {
        for (;;) {
          try { append(directory, chunk); return; } catch { await sleep(1000); }
        }
      });
    });
    process.stdin.on('end', () => { queue.then(() => resolve()); });
    process.stdin.on('error', () => { queue.then(() => resolve()); });
  });
}

function initializeAt(directory: string): void {
  ensurePrivateDir(directory);
  withLock(directory, () => trimLegacyLog(directory));
}

/** Runs the --daemon-log-writer mode. */
export async function run(): Promise<void> {
  let directory: string;
  try { directory = endpoint.directory(); initializeAt(directory); }
  catch (error: any) { process.stdout.write(String(error?.message ?? error)); throw error; }
  await new Promise<void>(resolve => process.stdout.write(Buffer.from([READY]), () => resolve()));
  await collect(directory);
}

/** Runs the --daemon-log-sink mode. */
export async function runSink(): Promise<void> {
  const directory = process.argv[3];
  if (!directory) throw new Error('Daemon log directory is missing');
  initializeAt(directory);
  await new Promise<void>(resolve => process.stdout.write('ready\n', () => resolve()));
  await collect(directory);
}

export function runningExecutable(): string { return daemonScript(); }

function firstOutput(child: ChildProcess, limit: number, timeout: number, done: (data: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]).subarray(0, limit);
      if (done(data)) { cleanup(); resolve(data); }
    };
    const onEnd = () => { cleanup(); resolve(data); };
    const cleanup = () => { clearTimeout(timer); child.stdout!.off('data', onData); child.stdout!.off('end', onEnd); };
    child.stdout!.on('data', onData);
    child.stdout!.on('end', onEnd);
  });
}

async function startConsumer(executable: string, directory: string): Promise<ChildProcess> {
  initializeAt(directory);
  let child: ChildProcess;
  try { child = spawn(executable, ['--daemon-log-sink', directory], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (error: any) { throw new Error('Could not start daemon logging: ' + error.message); }
  child.on('error', () => {});
  child.stdin!.on('error', () => {});
  let response: string;
  try {
    const data = await firstOutput(child, 1024, 5000, buffer => buffer.includes(10));
    response = data.toString('utf8');
  } catch {
    response = '';
    child.kill('SIGKILL');
    const message = 'Daemon logging did not initialize within five seconds';
    try { append(directory, Buffer.from('Could not start daemon logging: ' + message + '\n')); } catch {}
    throw new Error(message);
  }
  if (response.trim() !== 'ready') {
    child.kill('SIGKILL');
    const message = 'Daemon logging failed to initialize: ' + response.trim();
    try { append(directory, Buffer.from('Could not start daemon logging: ' + message + '\n')); } catch {}
    throw new Error(message);
  }
  child.stdout!.destroy();
  child.unref();
  return child;
}

/** Sends the stderr of the command to a new log sink process. Returns the log path. */
export async function configure(command: DaemonCommand, executable: string): Promise<string> {
  const directory = endpoint.directory();
  const sink = await startConsumer(executable, directory);
  command.stderr = sink.stdin;
  command.env[CAPTURED] = '1';
  return join(directory, 'daemon.log');
}

function environment(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete merged[key]; else merged[key] = value; }
  return merged;
}

function launchDetached(command: DaemonCommand): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(command.program, command.args, { detached: true, env: environment(command.env), stdio: ['ignore', 'ignore', command.stderr ?? 'ignore'] }); }
    catch (error: any) { reject(new Error('Could not start ' + command.program + ': ' + error.message)); return; }
    const stream = command.stderr;
    if (stream && typeof stream.destroy === 'function') stream.destroy();
    child.once('error', error => reject(new Error('Could not start ' + command.program + ': ' + error.message)));
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}

/** Starts a daemon process in its own session, with its stderr in daemon.log. */
export async function spawnDaemon(command: DaemonCommand): Promise<ChildProcess> {
  if (command.env[CAPTURED] !== undefined) return launchDetached(command);
  let writer: ChildProcess;
  try { writer = spawn(daemonScript(), ['--daemon-log-writer'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (error: any) { throw new Error('Could not start daemon log writer: ' + error.message); }
  writer.on('error', () => {});
  writer.stdin!.on('error', () => {});
  let ready: Buffer;
  try { ready = await firstOutput(writer, 8192, 10_000, buffer => buffer.length > 0 && (buffer[0] === READY || buffer.length >= 8192)); }
  catch { writer.kill('SIGKILL'); throw new Error('Daemon log writer did not become ready'); }
  if (ready[0] !== READY) { writer.kill('SIGKILL'); throw new Error('Could not initialize daemon log writer: ' + ready.toString('utf8')); }
  writer.stdout!.destroy();
  writer.unref();
  command.stderr = writer.stdin;
  command.env[CAPTURED] = '1';
  return launchDetached(command);
}

let sink: ChildProcess | undefined;

/** In the serving modes, sends this process's stderr to daemon.log. */
export async function initialize(): Promise<void> {
  if (!LOGGED_MODES.includes(process.argv[2] ?? '')) return;
  if (process.env[CAPTURED] !== undefined) return;
  const directory = endpoint.directory();
  sink = await startConsumer(runningExecutable(), directory);
  const input = sink.stdin!;
  (input as any).unref?.();
  process.stderr.write = ((chunk: any, encoding?: any, callback?: any) => input.write(chunk, encoding, callback)) as any;
}
