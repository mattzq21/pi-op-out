import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import { lockFile, type FileLock } from './util/flock';

/** Changes the extension of the file name, the same as Rust Path::with_extension. */
export function withExtension(path: string, extension: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return join(dirname(path), extension ? `${stem}.${extension}` : stem);
}

export function settingsRevision(body: Buffer | undefined): string {
  return body ? createHash('sha256').update(body).digest('hex') : 'missing';
}

/** Longest wait for a settings lock. Another process that keeps a lock longer than this is reported, not waited for. */
export const SETTINGS_LOCK_TIMEOUT_MS = 10_000;

export async function lockSettings(path: string): Promise<FileLock> {
  let lock: FileLock | undefined;
  try { lock = await lockFile(withExtension(path, 'lock'), 0o600, false, SETTINGS_LOCK_TIMEOUT_MS); }
  catch (error: any) { throw new Error(`Could not lock settings: ${error.message}`); }
  if (!lock) throw new Error('Settings are locked by another process; try again');
  return lock;
}

/** Locks the settings mutation file. Settings changes hold this lock. */
export async function storageLock(path: string): Promise<FileLock> {
  const parent = dirname(path);
  ensurePrivateDir(parent);
  const lockPath = withExtension(path, 'mutation.lock');
  const lock = await lockFile(lockPath, 0o600, false, SETTINGS_LOCK_TIMEOUT_MS);
  if (!lock) throw new Error('Settings storage is locked by another process; try again');
  try { setPrivateFilePermissions(lockPath); } catch (error) { lock.release(); throw error; }
  return lock;
}

export async function settingsPathAt(home: string): Promise<string> {
  const directory = join(home, STORAGE_DIRECTORY);
  ensurePrivateDir(directory);
  const path = join(directory, 'settings.json');
  const storage = await storageLock(path);
  try { (await lockSettings(path)).release(); } finally { storage.release(); }
  return path;
}

export function settingsPath(): Promise<string> { return settingsPathAt(homeDir()); }
