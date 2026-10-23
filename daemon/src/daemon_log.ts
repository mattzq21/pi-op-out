import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { dlopen, ptr } from 'bun:ffi';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { formatWithOptions } from 'node:util';
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

function collect(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    type Report = { kind: 'report'; data: Buffer; started: boolean; source: string; text: string; count: number };
    type Summary = { kind: 'summary'; data: Buffer; started: boolean; input: number; reports: number };
    const queue: (Report | Summary)[] = [];
    let lastReport: Report | undefined;
    let pendingSummary: Summary | undefined;
    let reportBytes = 0;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    let inputError: Error | undefined;
    let stopped = false;
    let latestStatus: string | null | undefined;
    let sentStatus: string | null | undefined;
    let writingStatus = false;
    let blockedStatus = false;

    const cleanup = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (endTimer) clearTimeout(endTimer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      process.stdout.off('drain', onDrain);
      process.stdout.off('close', onStatusClose);
    };
    const onStatusError = (error: Error) => {
      if (stopped) return;
      cleanup();
      process.stdin.pause();
      const failure = new Error('Could not write daemon log status: ' + errorMessage(error));
      process.stderr.write(failure.message + '\n');
      reject(failure);
    };
    const onStatusClose = () => onStatusError(new Error('Status channel closed'));
    const sendStatus = () => {
      if (stopped || writingStatus || blockedStatus || latestStatus === sentStatus) return;
      sentStatus = latestStatus;
      writingStatus = true;
      try {
        blockedStatus = !process.stdout.write(JSON.stringify({ error: sentStatus }) + '\n', error => {
          writingStatus = false;
          if (error) { onStatusError(error); return; }
          if (stopped) return;
          sendStatus();
          finish();
        });
      } catch (error) { onStatusError(error as Error); }
    };
    const status = (error: string | null) => { latestStatus = error; sendStatus(); };
    const onDrain = () => { blockedStatus = false; sendStatus(); finish(); };
    const lose = (input: number, reports: number) => {
      if (!input && !reports) return;
      if (!pendingSummary) {
        pendingSummary = { kind: 'summary', data: Buffer.alloc(0), started: false, input: 0, reports: 0 };
        queue.push(pendingSummary);
      }
      pendingSummary.input += input;
      pendingSummary.reports += reports;
    };
    const record = (source: string, error: unknown) => {
      const text = errorMessage(error);
      const message = `${source}: ${text}`;
      failed = true;
      status(message);
      if (lastReport && !lastReport.started && lastReport.source === source && lastReport.text === text) {
        const oldEnding = lastReport.count > 1 ? ` (repeated ${lastReport.count} times)\n` : '\n';
        const removed = Math.min(lastReport.data.length, Buffer.byteLength(oldEnding));
        lastReport.count += 1;
        const ending = Buffer.from(` (repeated ${lastReport.count} times)\n`);
        lastReport.data = Buffer.concat([lastReport.data.subarray(0, lastReport.data.length - removed), ending]);
        reportBytes += ending.length - removed;
      } else {
        const data = Buffer.from(`\n[daemon logging] ${message}\n`);
        lastReport = { kind: 'report', data, started: false, source, text, count: 1 };
        queue.push(lastReport);
        reportBytes += data.length;
      }
      let excess = Math.max(0, reportBytes - MAX_FAILURE_BYTES);
      lose(0, excess);
      for (let index = 0; excess && index < queue.length;) {
        const entry = queue[index];
        if (entry.kind !== 'report' || entry.started) { index += 1; continue; }
        const removed = Math.min(excess, entry.data.length);
        entry.data = Buffer.from(entry.data.subarray(removed));
        reportBytes -= removed;
        excess -= removed;
        if (entry.data.length) index += 1;
        else {
          queue.splice(index, 1);
          if (lastReport === entry) lastReport = undefined;
        }
      }
    };
    const finish = () => {
      if (stopped || !ended || failed || timer || writingStatus || blockedStatus || latestStatus !== sentStatus) return;
      cleanup();
      if (inputError) reject(inputError); else resolve();
    };
    const schedule = () => {
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        sentStatus = undefined;
        try {
          while (queue.length) {
            const entry = queue[0];
            if (entry.kind === 'summary' && !entry.started) {
              entry.data = Buffer.from(`\n[daemon logging] Lost ${entry.input} input bytes and ${entry.reports} error report bytes while daemon.log was unavailable.\n`);
            }
            append(directory, entry.data, written => {
              entry.started = true;
              if (entry.kind === 'summary') {
                if (pendingSummary === entry) pendingSummary = undefined;
              } else {
                reportBytes -= written;
                if (lastReport === entry) lastReport = undefined;
              }
              entry.data = entry.data.subarray(written);
              if (!entry.data.length) queue.shift();
            });
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
      if (failed) { lose(chunk.length, 0); return; }
      let remaining = chunk.length;
      try { append(directory, chunk, written => { remaining -= written; }); }
      catch (error) {
        lose(remaining, 0);
        record('Could not write daemon diagnostics', error);
        schedule();
      }
    };
    const onEnd = () => {
      ended = true;
      if (!endTimer) endTimer = setTimeout(() => {
        if (stopped) return;
        const failure = new Error('Daemon log could not finish within 10 seconds after input closed: ' + (latestStatus ?? 'status channel blocked'));
        cleanup();
        process.stderr.write(failure.message + '\n');
        reject(failure);
      }, 10_000);
      finish();
    };
    const onError = (error: Error) => {
      inputError = error;
      ended = true;
      process.stdin.pause();
      record('Could not read daemon diagnostics from stdin', error);
      schedule();
      onEnd();
    };
    process.stdout.on('drain', onDrain);
    process.stdout.on('error', onStatusError);
    process.stdout.once('close', onStatusClose);
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
  // Bun's console writes to file descriptor 2 directly and skips process.stderr.write, so route it through the sink too.
  for (const method of ['error', 'warn'] as const) {
    console[method] = (...values: unknown[]) => { process.stderr.write(formatWithOptions({ colors: false }, ...values) + '\n'); };
  }
}
