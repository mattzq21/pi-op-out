import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';

const CONFLICT = 75;

export class FileLock {
  constructor(public fd: number, public path: string) {}
  private released = false;

  release(): void {
    if (this.released) return;
    this.released = true;
    try { closeSync(this.fd); } catch {}
  }
}

function openLockFile(path: string, mode: number): number {
  return openSync(path, constants.O_RDWR | constants.O_CREAT, mode);
}

function lockArguments(blocking: boolean, shared: boolean): string[] {
  return [shared ? '--shared' : '--exclusive', ...(blocking ? [] : ['--nonblock']), '--conflict-exit-code', String(CONFLICT), '3'];
}

/** Locks an open descriptor through the util-linux flock command so the lock stays on this process's open file. */
export function flockDescriptorSync(fd: number, blocking = false, shared = false): boolean {
  const result = spawnSync('flock', lockArguments(blocking, shared), { stdio: ['ignore', 'ignore', 'pipe', fd] });
  if (result.error) throw new Error(`Could not run flock: ${result.error.message}`);
  if (result.status === 0) return true;
  if (result.status === CONFLICT) return false;
  throw new Error(result.stderr.toString().trim() || `flock exited with ${result.status ?? result.signal}`);
}

export function flockDescriptor(fd: number, blocking = true, shared = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', lockArguments(blocking, shared), { stdio: ['ignore', 'ignore', 'pipe', fd] });
    let stderr = '';
    child.stderr!.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on('error', error => reject(new Error(`Could not run flock: ${error.message}`)));
    child.on('close', (status, signal) => {
      if (status === 0) resolve(true);
      else if (status === CONFLICT) resolve(false);
      else reject(new Error(stderr.trim() || `flock exited with ${status ?? signal}`));
    });
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

export async function lockFile(path: string, mode = 0o600, shared = false): Promise<FileLock> {
  const fd = openLockFile(path, mode);
  try {
    if (await flockDescriptor(fd, true, shared)) return new FileLock(fd, path);
    throw new Error('Could not lock file');
  } catch (error) { closeSync(fd); throw error; }
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
