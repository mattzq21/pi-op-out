import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { dlopen, ptr } from 'bun:ffi';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import * as endpoint from './daemon_endpoint';
import { daemonScript } from './session_worker';
import { lockPathSync } from './util/flock';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BACKUP_COUNT = 4;
const MAX_FAILURE_BYTES = 64 * 1024;
const STATUS_FD = 'PIOP_DAEMON_LOG_STATUS_FD';
const CAPTURED = 'PIOP_DAEMON_LOG_CAPTURED';
const LOGGED_MODES = ['--serve', '--exit-on-disconnect', '--restart-candidate', '--restart-coordinator', '--validate-plugins'];

/** A child process description for daemon processes that write to daemon.log. */
export interface DaemonCommand { program: string; args: string[]; env: Record<string, string | undefined>; stderr?: any; logStatus?: Socket; logStatusFd?: number }

function privateFile(path: string, flags: string): number {
  const fd = openSync(path, flags, 0o600);
  try { setPrivateFilePermissions(path); } catch (error) {
    withCleanup(() => { throw error; }, () => closeSync(fd));
  }
  return fd;
}

function withCleanup<T>(operation: () => T, cleanup: () => void): T {
  let result: T | undefined;
  const errors: unknown[] = [];
  try { result = operation(); } catch (error) { errors.push(error); }
  try { cleanup(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(errorMessage).join('; '));
  return result as T;
}

function withLock<T>(directory: string, operation: () => T): T {
  const first = lockPathSync(join(directory, 'daemon-log.lock'));
  return withCleanup(() => {
    setPrivateFilePermissions(join(directory, 'daemon-log.lock'));
    const second = lockPathSync(join(directory, 'daemon.log.lock'));
    return withCleanup(operation, () => second.release());
  }, () => first.release());
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
  withCleanup(() => {
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
      withCleanup(() => { ftruncateSync(target, 0); writeSync(target, buffer, 0, read); fsyncSync(target); }, () => closeSync(target));
      renameSync(temporary, path);
    } catch (error) { withCleanup(() => { throw error; }, () => removeIfPresent(temporary)); }
  }, () => closeSync(source));
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorMessage).join('; ');
  return error instanceof Error ? error.message : String(error);
}

function append(directory: string, data: Buffer, progress?: (written: number) => void): void {
  withLock(directory, () => {
    let pending = data;
    while (pending.length) {
      const fd = privateFile(join(directory, 'daemon.log'), 'a');
      let rotateNext = false;
      const errors: unknown[] = [];
      try {
        const length = fstatSync(fd).size;
        rotateNext = length >= MAX_FILE_BYTES;
        if (!rotateNext) {
          const count = Math.min(pending.length, MAX_FILE_BYTES - length);
          const written = writeSync(fd, pending, 0, count);
          if (written === 0) throw new Error('Could not write daemon diagnostics');
          pending = pending.subarray(written);
          progress?.(written);
        }
      } catch (error) { errors.push(error); }
      try { closeSync(fd); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, errors.map(errorMessage).join('; '));
      if (rotateNext) rotate(directory);
    }
  });
}

function status(error: string | null): void {
  process.stdout.write(JSON.stringify({ error }) + '\n');
}

function collect(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let failures = Buffer.alloc(0);
    let summary = Buffer.alloc(0);
    let failed = false;
    let lostBytes = 0;
    let lostReportBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    let inputError: Error | undefined;

    const record = (source: string, error: unknown) => {
      const text = errorMessage(error);
      if (!failed) { failed = true; status(`${source}: ${text}`); }
      const report = Buffer.from(`\n[daemon logging] ${source}: ${text}\n`);
      const combined = Buffer.concat([failures, report]);
      const excess = Math.max(0, combined.length - MAX_FAILURE_BYTES);
      lostReportBytes += excess;
      failures = Buffer.from(combined.subarray(excess));
    };
    const finish = () => {
      if (!ended || failed || timer) return;
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      if (inputError) reject(inputError); else resolve();
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        try {
          for (;;) {
            if (!summary.length && (lostBytes || lostReportBytes)) {
              summary = Buffer.from(`\n[daemon logging] Lost ${lostBytes} input bytes and ${lostReportBytes} error report bytes while daemon.log was unavailable.\n`);
              lostBytes = 0;
              lostReportBytes = 0;
            }
            if (summary.length) append(directory, summary, written => { summary = summary.subarray(written); });
            if (failures.length) append(directory, failures, written => { failures = failures.subarray(written); });
            if (!lostBytes && !lostReportBytes) break;
          }
          failed = false;
          status(null);
        } catch (error) {
          record('Could not write daemon diagnostics', error);
          schedule();
        }
        finish();
      }, 1000);
    };
    const onData = (chunk: Buffer) => {
      if (failed) { lostBytes += chunk.length; return; }
      let remaining = chunk.length;
      try { append(directory, chunk, written => { remaining -= written; }); }
      catch (error) {
        lostBytes += remaining;
        record('Could not write daemon diagnostics', error);
        schedule();
      }
    };
    const onEnd = () => { ended = true; finish(); };
    const onError = (error: Error) => {
      inputError = error;
      ended = true;
      process.stdin.pause();
      record('Could not read daemon diagnostics from stdin', error);
      schedule();
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
  });
}

function initializeAt(directory: string): void {
  ensurePrivateDir(directory);
  withLock(directory, () => trimLegacyLog(directory));
}

async function runCollector(directory: () => string): Promise<void> {
  let path: string;
  try { path = directory(); initializeAt(path); }
  catch (error) {
    await new Promise<void>(resolve => process.stdout.write(JSON.stringify({ error: errorMessage(error) }) + '\n', () => resolve()));
    throw error;
  }
  await new Promise<void>(resolve => process.stdout.write('ready\n', () => resolve()));
  await collect(path);
}

export async function run(): Promise<void> { await runCollector(() => endpoint.directory()); }

export async function runSink(): Promise<void> {
  await runCollector(() => {
    const directory = process.argv[3];
    if (!directory) throw new Error('Daemon log directory is missing');
    return directory;
  });
}

export function runningExecutable(): string { return daemonScript(); }

function waitReady(child: ChildProcess, output: Readable, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let line = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      output.off('readable', onReadable);
      output.off('end', onEnd);
      output.off('error', onError);
      child.off('error', onError);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error('Daemon logging closed before readiness: ' + line));
    const onReadable = () => {
      let byte: Buffer | null;
      while ((byte = output.read(1)) !== null) {
        if (byte[0] === 10) {
          if (line === 'ready') finish();
          else {
            let cause = Buffer.from(line, 'latin1').toString('utf8');
            try { cause = JSON.parse(cause).error ?? cause; } catch { /* plain startup error */ }
            finish(new Error('Daemon logging failed to initialize: ' + cause));
          }
          return;
        }
        line += byte.toString('latin1');
        if (line.length >= 65536) { finish(new Error('Daemon logging readiness response is too long')); return; }
      }
    };
    const timer = setTimeout(() => finish(new Error('Daemon logging readiness timed out')), timeout);
    output.on('readable', onReadable);
    output.once('end', onEnd);
    output.once('error', onError);
    child.once('error', onError);
  });
}

function loadPipeLibrary() {
  return dlopen('libc.so.6', { socketpair: { args: ['i32', 'i32', 'i32', 'ptr'], returns: 'i32' } });
}

let pipeLibrary: ReturnType<typeof loadPipeLibrary> | undefined;

function statusPipe(): [number, number] {
  pipeLibrary ??= loadPipeLibrary();
  const descriptors = new Int32Array(2);
  if (pipeLibrary.symbols.socketpair(1, 1 | 0x80000, 0, ptr(descriptors)) !== 0) throw new Error('Could not create daemon log status pipe');
  return [descriptors[0]!, descriptors[1]!];
}

async function startConsumer(executable: string, directory: string, writer = false): Promise<{ child: ChildProcess; output: Socket; fd: number }> {
  const [readFd, writeFd] = statusPipe();
  let output: Socket;
  try { output = connect({ fd: readFd } as any); }
  catch (error) { withCleanup(() => withCleanup(() => { throw error; }, () => closeSync(readFd)), () => closeSync(writeFd)); throw error; }
  let child: ChildProcess;
  try {
    child = withCleanup(() => spawn(executable, writer ? ['--daemon-log-writer'] : ['--daemon-log-sink', directory], {
      detached: true, stdio: ['pipe', writeFd, 'ignore'],
    }), () => closeSync(writeFd));
  } catch (error) { output.destroy(); throw error; }
  child.stdin!.on('error', error => setStatus('Daemon log input failed: ' + errorMessage(error)));
  try { await waitReady(child, output, writer ? 10000 : 5000); }
  catch (error) { child.kill('SIGKILL'); output.destroy(); child.stdin!.destroy(); throw error; }
  child.on('error', error => setStatus('Daemon log process failed: ' + errorMessage(error)));
  child.unref();
  return { child, output, fd: readFd };
}

let currentStatus: string | null = null;
const statusListeners = new Set<(failure: string | null) => void>();

function setStatus(error: string | null): void {
  if (error === currentStatus) return;
  currentStatus = error;
  for (const listener of statusListeners) listener(error);
}

export function listenStatus(listener: (failure: string | null) => void): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => { statusListeners.delete(listener); };
}

function readStatus(input: Readable): void {
  const lines = createInterface({ input });
  let broken = false;
  const onError = (error: Error) => { broken = true; setStatus('Daemon log status failed: ' + errorMessage(error)); };
  lines.on('error', onError);
  input.on('error', onError);
  lines.on('line', line => {
    try {
      const packet = JSON.parse(line);
      if (packet.error !== null && typeof packet.error !== 'string') throw new Error('Invalid status');
      setStatus(packet.error === null ? null : 'Daemon logging failed: ' + packet.error);
    } catch (error) { setStatus('Invalid daemon log status: ' + errorMessage(error)); }
  });
  lines.on('close', () => { if (!broken) setStatus('Daemon log status closed; logging is unavailable.'); });
}

/** Sends the stderr of the command to a new log sink process. Returns the log path. */
export async function configure(command: DaemonCommand, executable: string): Promise<string> {
  const directory = endpoint.directory();
  const sink = await startConsumer(executable, directory);
  command.stderr = sink.child.stdin;
  command.logStatus = sink.output;
  command.logStatusFd = sink.fd;
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
    if (command.logStatus) command.env[STATUS_FD] = '3';
    let child: ChildProcess;
    try { child = spawn(command.program, command.args, { detached: true, env: environment(command.env), stdio: ['ignore', 'ignore', command.stderr ?? 'ignore', ...(command.logStatusFd !== undefined ? [command.logStatusFd] : [])] }); }
    catch (error: any) {
      command.logStatus?.destroy();
      command.stderr?.destroy?.();
      reject(new Error('Could not start ' + command.program + ': ' + error.message));
      return;
    }
    command.logStatus?.destroy();
    const stream = command.stderr;
    if (stream && typeof stream.destroy === 'function') stream.destroy();
    child.once('error', error => reject(new Error('Could not start ' + command.program + ': ' + error.message)));
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}

/** Starts a daemon process in its own session, with its stderr in daemon.log. */
export async function spawnDaemon(command: DaemonCommand): Promise<ChildProcess> {
  if (command.env[CAPTURED] !== undefined) return launchDetached(command);
  const writer = await startConsumer(daemonScript(), endpoint.directory(), true);
  command.logStatus = writer.output;
  command.logStatusFd = writer.fd;
  command.stderr = writer.child.stdin;
  command.env[CAPTURED] = '1';
  return launchDetached(command);
}

let sink: Awaited<ReturnType<typeof startConsumer>> | undefined;

/** In the serving modes, sends this process's stderr to daemon.log. */
export async function initialize(): Promise<void> {
  if (!LOGGED_MODES.includes(process.argv[2] ?? '')) return;
  const statusFd = process.env[STATUS_FD];
  delete process.env[STATUS_FD];
  if (statusFd !== undefined) readStatus(connect({ fd: Number(statusFd) } as any));
  if (process.env[CAPTURED] !== undefined) return;
  const directory = endpoint.directory();
  sink = await startConsumer(runningExecutable(), directory);
  readStatus(sink.output);
  const input = sink.child.stdin!;
  (input as any).unref?.();
  process.stderr.write = ((chunk: any, encoding?: any, callback?: any) => input.write(chunk, encoding, callback)) as any;
}
