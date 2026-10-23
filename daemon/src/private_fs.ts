import { chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export function setPrivateFilePermissions(path: string): void {
  if (!existsSync(path)) return;
  const stats = statSync(path);
  if (stats.isDirectory()) throw new Error(`Configuration path is a directory: ${path}`);
  if ((stats.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true });
  const stats = statSync(path);
  if ((stats.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

export interface Publication { committed: boolean; durable: boolean; error?: string }

function committed(error?: string): Publication {
  return error === undefined ? { committed: true, durable: true } : { committed: true, durable: false, error };
}

function privateFileMatches(path: string, body: Buffer): boolean {
  if (!existsSync(path)) return false;
  if (statSync(path).isDirectory()) throw new Error(`Configuration path is a directory: ${path}`);
  setPrivateFilePermissions(path);
  try { return readFileSync(path).equals(body); } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function attempt(operation: () => void): string | undefined {
  try { operation(); return undefined; } catch (error: any) { return error?.message ?? String(error); }
}

export function syncDirectoryAncestors(path: string): void {
  let directory: string;
  try { directory = realpathSync(path); } catch (error: any) { throw new Error(`Could not resolve saved directory ${path}: ${error.message}`); }
  for (;;) {
    try {
      const fd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error: any) { throw new Error(`Could not sync saved directory ${directory}: ${error.message}`); }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

export function publishPrivate(path: string, content: Buffer | string): Publication {
  const body = typeof content === 'string' ? Buffer.from(content) : content;
  const parent = dirname(path);
  ensurePrivateDir(parent);
  if (privateFileMatches(path, body)) {
    const error = attempt(() => {
      try { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
      catch (error: any) { throw new Error(`Could not sync saved configuration: ${error.message}`); }
      syncDirectoryAncestors(parent);
    });
    return committed(error);
  }
  const temporary = join(parent, `.${basename(path) || 'config'}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      chmodSync(temporary, 0o600);
      let offset = 0;
      while (offset < body.length) offset += writeSync(fd, body, offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { renameSync(temporary, path); } catch (error: any) {
      if (existsSync(path) && statSync(path).isDirectory()) throw new Error(`Configuration path is a directory: ${path}`);
      throw error;
    }
    return committed(attempt(() => syncDirectoryAncestors(parent)));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function atomicWritePrivate(path: string, body: Buffer | string): void {
  const publication = publishPrivate(path, body);
  if (publication.error) throw new Error(publication.error);
}
