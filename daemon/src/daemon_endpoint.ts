import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEVELOPMENT, PROJECT_DIR, PROTOCOL_VERSION, STORAGE_DIRECTORY, developmentEndpointKey } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import * as records from './settings_records';
import * as restartStorage from './restart_storage';
import { tryLockFileSync, type FileLock } from './util/flock';
import { generatedExtensionRoot } from './extensions';

export const STARTUP_TIMEOUT = 90_000;

/** Exit code of a daemon that stops because another daemon already runs for the same directory. */
export const ALREADY_RUNNING_EXIT_CODE = 3;

export class DaemonAlreadyRunningError extends Error {}

/** The address and token clients use to reach the daemon. */
export interface Endpoint { url: string; token: string; protocol: number }

export function directory(): string {
  const root = join(homeDir(), STORAGE_DIRECTORY);
  if (!DEVELOPMENT) return root;
  if (!PROJECT_DIR) throw new Error('Cannot locate project directory');
  return join(root, 'daemons', developmentEndpointKey(PROJECT_DIR));
}

export function path(): string { return join(directory(), 'daemon.json'); }

let runtime: any;

/** Development details about this daemon process. */
export function debugRuntime(): any {
  if (runtime) return runtime;
  const executable = Bun.isStandaloneExecutable ? process.execPath : resolve(process.argv[1] ?? process.execPath);
  const extensionRoot = generatedExtensionRoot();
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
  const body = records.read(path());
  if (!body) throw new Error('Daemon connection is not available');
  return JSON.parse(body.toString('utf8'));
}

export function restartActive(): boolean {
  try {
    const status = restartStorage.read(join(directory(), 'restart-status.json'));
    if (!status) return false;
    const now = Math.floor(Date.now() / 1000);
    return ['preparing', 'armed', 'restarting'].includes(status.phase) && Number(status.expiresAt ?? 0) > now;
  } catch { return false; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function identity(): string {
  const bytes = records.readOrCreate(join(directory(), 'daemon-id'), randomUUID());
  const value = bytes.toString('utf8').trim();
  if (!UUID.test(value)) throw new Error('Invalid daemon identity');
  return value.toLowerCase();
}

export function claim(): FileLock {
  const root = directory();
  ensurePrivateDir(root);
  const file = join(root, 'daemon.lock');
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
  records.publish(path(), endpointRecord(address, port, token));
}

/** Removes this daemon's endpoint record so clients stop sending its token to whatever listens on the port next. */
export function unpublish(address: string, port: number, token: string): void {
  records.removeIfEqual(path(), endpointRecord(address, port, token));
}
