import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, futimesSync, openSync, readFileSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { DEVELOPMENT, PROJECT_DIR, PROTOCOL_VERSION, STORAGE_DIRECTORY } from '../config';
import { homeDir } from '../environment';
import { ensurePrivateDir, setPrivateFilePermissions } from '../private_fs';
import { records } from '../../resources/session-database/index.ts';
import * as restartStorage from '../restart_storage';
import { tryLockFileSync, type FileLock } from '../util/flock';
import { extensionBase } from '../extensions';
import { libcName } from '../util/libc';
import { untilSignal } from '../util/storage_change';

export const STARTUP_TIMEOUT = 90_000;

export const ALREADY_RUNNING_EXIT_CODE = 3;

export class DaemonAlreadyRunningError extends Error {}

// How a client connects to the running daemon.
const endpointSchema = Type.Object({ url: Type.String(), token: Type.String(), protocol: Type.Integer() });
export type Endpoint = Static<typeof endpointSchema>;

export function directory(): string {
  return join(homeDir(), STORAGE_DIRECTORY);
}


let runtime: any;

export function debugRuntime(): any {
  if (runtime) return runtime;
  const executable = Bun.isStandaloneExecutable ? process.execPath : resolve(process.argv[1] ?? process.execPath);
  const extensionRoot = extensionBase();
  runtime = {
    processId: process.pid,
    project: PROJECT_DIR || null,
    executable,
    buildIdentity: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    profileHome: homeDir(),
    daemonDirectory: directory(),
    daemonLog: join(directory(), 'daemon.log'),
    extensionRoot,
  };
  return runtime;
}

export function read(): Endpoint {
  const body = records.read(directory(), 'daemon');
  if (!body) throw new Error('Daemon connection is not available');
  const endpoint = JSON.parse(body.toString('utf8'));
  if (!Check(endpointSchema, endpoint)) throw new Error('The saved daemon connection is not valid');
  return endpoint;
}

// When the restart that runs now must end at the latest, in ms since 1970; undefined when no restart runs.
export function restartEnds(): number | undefined {
  try {
    const status = restartStorage.read(directory(), 'status');
    if (!status) return undefined;
    const ends = Number(status.expiresAt ?? 0) * 1000;
    return ['preparing', 'armed', 'restarting'].includes(status.phase) && ends > Date.now() ? ends : undefined;
  } catch { return undefined; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function identity(): string {
  const bytes = records.readOrCreate(directory(), 'daemon-id', randomUUID());
  const value = bytes.toString('utf8').trim();
  if (!UUID.test(value)) throw new Error('Invalid daemon identity');
  return value.toLowerCase();
}

const SIGNAL = 'daemon.signal';
const LOCK = 'daemon.lock';

// Tells waiters that the endpoint or restart records changed. Call after the change is committed.
export function signal(): void {
  const fd = openSync(join(directory(), SIGNAL), 'a', 0o600);
  try { futimesSync(fd, new Date(), new Date()); } finally { closeSync(fd); }
}

// A process that waits until it gets the daemon lock and then lets it go at once: the end of the process tells that
// the daemon lock is free, also when its holder crashed.
function lockFreed(): { freed: Promise<void>; cancel: () => void } {
  const source = `
import { dlopen, read } from 'bun:ffi';
const library = dlopen(${JSON.stringify(libcName())}, {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' },
});
const fd = openSync(process.argv[1], constants.O_RDONLY | constants.O_CREAT, 0o600);
let error;
do { error = library.symbols.flock(fd, 2) === 0 ? 0 : read.i32(library.symbols.__errno_location()); } while (error === 4);
if (error) throw new Error('flock failed (errno ' + error + ')');
`;
  const child = spawn(process.execPath, ['-e', source, join(directory(), LOCK)], { env: { ...process.env, BUN_BE_BUN: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let cancelled = false;
  const errors: Buffer[] = [];
  child.stderr!.on('data', chunk => errors.push(chunk));
  const freed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (cancelled) return;
      if (code === 0) resolve();
      else reject(new Error('Could not wait for the daemon lock: ' + (Buffer.concat(errors).toString().trim() || 'code ' + code + ', signal ' + signal)));
    });
  });
  return { freed, cancel: () => { cancelled = true; child.kill('SIGKILL'); } };
}

// Runs check now and after each signal, until it gives a value or ms pass; see untilSignal. With released, check also
// runs when the daemon lock becomes free.
export async function untilChange<T>(check: () => Promise<T | undefined> | T | undefined, ms: number, options: { also?: Promise<unknown>; released?: boolean } = {}): Promise<T | undefined> {
  const lock = options.released ? lockFreed() : undefined;
  try {
    return await untilSignal(directory(), SIGNAL, check, ms, [options.also, lock?.freed].filter(promise => promise !== undefined));
  } finally { lock?.cancel(); }
}

export function claim(): FileLock {
  const root = directory();
  ensurePrivateDir(root);
  const file = join(root, LOCK);
  const lock = tryLockFileSync(file, 0o600);
  if (!lock) throw new DaemonAlreadyRunningError(DEVELOPMENT ? 'A Piop debug daemon is already running for this worktree' : 'A Piop daemon is already running for this configuration directory');
  setPrivateFilePermissions(file);
  return lock;
}

function endpointRecord(address: string, port: number, token: string): string {
  let ip = address;
  if (ip === '0.0.0.0') ip = '127.0.0.1';
  if (ip === '::') ip = '::1';
  const host = ip.includes(':') ? '[' + ip + ']' : ip;
  const endpoint: Endpoint = { url: 'ws://' + host + ':' + port, token, protocol: PROTOCOL_VERSION };
  return JSON.stringify(endpoint);
}

export function publish(address: string, port: number, token: string): void {
  records.save(directory(), 'daemon', endpointRecord(address, port, token));
  signal();
}

export function unpublish(address: string, port: number, token: string): void {
  records.removeIfEqual(directory(), 'daemon', endpointRecord(address, port, token));
  signal();
}
