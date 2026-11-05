import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { DEVELOPMENT, PROJECT_DIR, PROTOCOL_VERSION, STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import * as records from '../resources/application-records.cjs';
import * as restartStorage from './restart_storage';
import { tryLockFileSync, type FileLock } from './util/flock';
import { extensionBase } from './extensions';

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
  records.save(directory(), 'daemon', endpointRecord(address, port, token));
}

export function unpublish(address: string, port: number, token: string): void {
  records.removeIfEqual(directory(), 'daemon', endpointRecord(address, port, token));
}
