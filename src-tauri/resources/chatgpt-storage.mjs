import { constants as chatStorageFlags, openSync as chatStorageOpen, closeSync as chatStorageClose, fstatSync as chatStorageStat, lstatSync as chatStorageLstat, mkdirSync as chatStorageMkdir } from 'node:fs';
import { open as chatStorageOpenFile, rename as chatStorageRename, rm as chatStorageRemove } from 'node:fs/promises';
import { spawnSync as chatStorageSpawn } from 'node:child_process';
import { join as chatStorageJoin, dirname as chatStorageDirname } from 'node:path';
import { randomUUID as chatStorageUuid } from 'node:crypto';

const chatStorageLocks = new Map();

function chatGptStoragePath(identity, id) { return chatStorageJoin(identity.directory, '.locks', `${id}.lock`); }

function chatGptStorageLockDescriptor(path) {
  const directory = chatStorageDirname(path);
  chatStorageMkdir(directory, { recursive: true, mode: 0o700 });

  if (!chatStorageLstat(directory).isDirectory()) throw new Error('Invalid ChatGPT lock directory.');
  const fd = chatStorageOpen(path, chatStorageFlags.O_CREAT | chatStorageFlags.O_RDWR | chatStorageFlags.O_NOFOLLOW, 0o600);

  try {
    if (!chatStorageStat(fd).isFile()) throw new Error('Invalid ChatGPT lock file.');
    const locked = chatStorageSpawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 });

    if (locked.error) throw locked.error;

    if (locked.status === 1) { chatStorageClose(fd);

    return undefined; }

    if (locked.status !== 0) throw new Error('Could not acquire the shared ChatGPT editing lock.');

    return fd;
  } catch (error) { chatStorageClose(fd); throw error; }
}

export function chatGptAcquireStorage(identity, id) {
  const path = chatGptStoragePath(identity, id);
  const held = chatStorageLocks.get(path);

  if (held) { held.references++;

  return held; }

  const fd = chatGptStorageLockDescriptor(path);

  if (fd === undefined) return undefined;
  const lock = { fd, path, references: 1 };
  chatStorageLocks.set(path, lock);

  return lock;
}

export function chatGptRetainStorage(identity, id) {
  const held = chatStorageLocks.get(chatGptStoragePath(identity, id));

  if (!held) throw new Error('This daemon does not own the shared ChatGPT editing lock.');
  held.references++;

  return held;
}

export function chatGptReleaseStorage(lock) {
  if (!lock) return;
  lock.references--;

  if (lock.references) return;
  chatStorageLocks.delete(lock.path);
  chatStorageClose(lock.fd);
}

export async function chatGptSyncStorageDirectory(path) {
  const directory = await chatStorageOpenFile(path, chatStorageFlags.O_RDONLY | chatStorageFlags.O_DIRECTORY | chatStorageFlags.O_NOFOLLOW);

  try { await directory.sync(); }
  finally { await directory.close(); }
}

export async function chatGptPublishDocument(path, data) {
  const temporary = `${path}.${chatStorageUuid()}.tmp`;
  const file = await chatStorageOpenFile(temporary, 'wx', 0o600);

  try {
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }

    await chatStorageRename(temporary, path);
    await chatGptSyncStorageDirectory(chatStorageDirname(path));
  } finally { await chatStorageRemove(temporary, { force: true }); }
}
