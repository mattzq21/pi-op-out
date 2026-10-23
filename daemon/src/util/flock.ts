import { dlopen, read } from 'bun:ffi';
import { spawn } from 'node:child_process';
import { getSystemErrorName } from 'node:util';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';

const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4;
const EINTR = 4, EAGAIN = 11;

function loadLibc() {
  const library = dlopen('libc.so.6', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
    dup: { args: ['i32'], returns: 'i32' },
    __errno_location: { args: [], returns: 'ptr' },
  });
  const errno = library.symbols.__errno_location();
  if (!errno) throw new Error('Could not get flock errno address');
  return { library, errno };
}

let libc: ReturnType<typeof loadLibc> | undefined;

function flockError(errno: number): Error {
  return new Error(`flock failed: ${getSystemErrorName(-errno)} (errno ${errno})`);
}

const WORKER_SOURCE = `
import { dlopen, read } from 'bun:ffi';
const library = dlopen('libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' },
});
const errno = library.symbols.__errno_location();
if (!errno) throw new Error('Could not get flock errno address');
self.onmessage = ({ data: { fd, operation } }) => {
  let error;
  do {
    error = library.symbols.flock(fd, operation) === 0 ? 0 : read.i32(errno);
  } while (error === ${EINTR});
  self.postMessage(error);
};
`;

const CHILD_SOURCE = `
import { dlopen, read } from 'bun:ffi';
import { getSystemErrorName } from 'node:util';
const library = dlopen('libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' },
});
const errno = library.symbols.__errno_location();
if (!errno) throw new Error('Could not get flock errno address');
let error;
do {
  error = library.symbols.flock(3, Number(process.argv[1])) === 0 ? 0 : read.i32(errno);
} while (error === ${EINTR});
if (error) throw new Error('flock failed: ' + getSystemErrorName(-error) + ' (errno ' + error + ')');
`;

function timedFlock(fd: number, shared: boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_SOURCE, String(shared ? LOCK_SH : LOCK_EX)], {
      env: { ...process.env, BUN_BE_BUN: '1' },
      stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    const errors: Buffer[] = [];
    let failure: Error | undefined;
    let timedOut = false;
    child.once('error', error => { failure = error; });
    child.stderr?.on('data', chunk => errors.push(chunk));
    child.stderr?.on('error', error => { failure = error; child.kill('SIGKILL'); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      try {
        if (failure) throw failure;
        if (status !== 0 && !(timedOut && signal === 'SIGKILL')) {
          throw new Error(Buffer.concat(errors).toString().trim() || `flock child exited without a result (code ${status}, signal ${signal})`);
        }
        resolve(timedOut ? flockDescriptorSync(fd, false, shared) : true);
      } catch (error) { reject(error); }
    });
  });
}

export class FileLock {
  constructor(public fd: number, public path: string) {}
  private released = false;

  release(): void {
    if (this.released) return;
    closeSync(this.fd);
    this.released = true;
  }
}

function openLockFile(path: string, mode: number): number {
  return openSync(path, constants.O_RDWR | constants.O_CREAT, mode);
}

export function flockDescriptorSync(fd: number, blocking = false, shared = false): boolean {
  const { library, errno } = libc ??= loadLibc();
  const operation = (shared ? LOCK_SH : LOCK_EX) | (blocking ? 0 : LOCK_NB);
  let error: number;
  do {
    error = library.symbols.flock(fd, operation) === 0 ? 0 : read.i32(errno);
  } while (error === EINTR);
  if (!error) return true;
  if (error === EAGAIN) return false;
  throw flockError(error);
}

export async function flockDescriptor(fd: number, blocking = true, shared = false, timeoutMs?: number): Promise<boolean> {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) throw new Error('Invalid flock timeout');
  if (flockDescriptorSync(fd, false, shared)) return true;
  if (!blocking || timeoutMs === 0) return false;
  if (timeoutMs !== undefined) return timedFlock(fd, shared, timeoutMs);
  const { library, errno } = libc ??= loadLibc();
  const duplicate = library.symbols.dup(fd);
  if (duplicate === -1) {
    const error = read.i32(errno);
    throw new Error(`dup failed: ${getSystemErrorName(-error)} (errno ${error})`);
  }
  return new Promise((resolve, reject) => {
    let url: string | undefined;
    let worker: Worker | undefined;
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      try { closeSync(duplicate); } catch (closeError) { error = error ? new AggregateError([error, closeError], 'flock cleanup failed') : closeError; }
      if (error) reject(error);
      else resolve(true);
    };
    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = ({ data }) => {
        if (!Number.isInteger(data) || data < 0) finish(new Error('Invalid flock worker result'));
        else finish(data === 0 ? undefined : flockError(data));
      };
      worker.onerror = event => finish(new Error(`flock worker failed: ${event.message}`));
      worker.onmessageerror = () => finish(new Error('Could not read flock worker result'));
      worker.addEventListener('close', event => finish(new Error(`flock worker exited without a result (code ${event.code})`)));
      worker.postMessage({ fd: duplicate, operation: shared ? LOCK_SH : LOCK_EX });
    } catch (error) { finish(error); }
  });
}

export function tryLockFileSync(path: string, mode = 0o600, shared = false): FileLock | undefined {
  const fd = openLockFile(path, mode);
  try {
    if (flockDescriptorSync(fd, false, shared)) return new FileLock(fd, path);
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  return undefined;
}

export async function tryLockFile(path: string, mode = 0o600, shared = false): Promise<FileLock | undefined> {
  const fd = openLockFile(path, mode);
  try {
    if (await flockDescriptor(fd, false, shared)) return new FileLock(fd, path);
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  return undefined;
}

export function lockFile(path: string, mode?: number, shared?: boolean): Promise<FileLock>;
export function lockFile(path: string, mode: number | undefined, shared: boolean | undefined, timeoutMs: number | undefined): Promise<FileLock | undefined>;
export async function lockFile(path: string, mode = 0o600, shared = false, timeoutMs?: number): Promise<FileLock | undefined> {
  const fd = openLockFile(path, mode);
  try {
    if (await flockDescriptor(fd, true, shared, timeoutMs)) return new FileLock(fd, path);
    if (timeoutMs === undefined) throw new Error('Could not lock file');
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  return undefined;
}

export function lockFd(lock: FileLock): number { return lock.fd; }

export interface LockPathOptions {
  shared?: boolean;
  nofollow?: boolean;
  /** Error text used when the path is not a regular file. */
  regularFile?: string;
  blocking?: boolean;
}

/** Opens a lock file with private permissions and takes a flock on it. Returns undefined only for a non-blocking conflict. */
export function lockPathSync(path: string, options: LockPathOptions & { blocking: false }): FileLock | undefined;
export function lockPathSync(path: string, options?: LockPathOptions): FileLock;
export function lockPathSync(path: string, options: LockPathOptions = {}): FileLock | undefined {
  const flags = constants.O_RDWR | constants.O_CREAT | (options.nofollow ? constants.O_NOFOLLOW : 0);
  const fd = openSync(path, flags, 0o600);
  try {
    if (options.regularFile !== undefined && !fstatSync(fd).isFile()) throw new Error(options.regularFile);
    if (flockDescriptorSync(fd, options.blocking ?? true, options.shared ?? false)) return new FileLock(fd, path);
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  if (options.blocking ?? true) throw new Error('Could not lock ' + path);
  return undefined;
}

export async function lockPath(path: string, options: LockPathOptions & { timeoutMs?: number }): Promise<FileLock | undefined> {
  const flags = constants.O_RDWR | constants.O_CREAT | (options.nofollow ? constants.O_NOFOLLOW : 0);
  const fd = openSync(path, flags, 0o600);
  try {
    if (options.regularFile !== undefined && !fstatSync(fd).isFile()) throw new Error(options.regularFile);
    if (await flockDescriptor(fd, options.blocking ?? true, options.shared ?? false, options.timeoutMs)) return new FileLock(fd, path);
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  if ((options.blocking ?? true) && options.timeoutMs === undefined) throw new Error('Could not lock ' + path);
  return undefined;
}
