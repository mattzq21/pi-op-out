import fs from 'node:fs';
import path from 'node:path';
import * as database from '../../resources/session-database/index.ts';
import { onMainThread } from '../../resources/session-database/index.ts';

function directoryExists(directory: string): boolean {
  try {
    const info = fs.lstatSync(directory);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Temporary chat path must be a directory, not a link');

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Saves which folder belongs to the temporary chat id, or returns the one it has.
const allocate = onMainThread('temporary-chat.allocate', (root: string, id: string) => {
  return database.transaction(root, 'IMMEDIATE', () => {
    let directory = database.temporaryChatFolder(root, id);

    if (directory === undefined) {
      directory = folderNames(id).map(name => path.join(root, 'tmp', name)).find(candidate => database.temporaryChatOwner(root, candidate) === undefined && !directoryExists(candidate));

      if (directory === undefined) throw new Error('Every folder name for this temporary chat is in use');
      database.insertTemporaryChatFolder(root, id, directory);
    } else if (!ownsFolder(root, id, directory)) throw new Error('Temporary chat directory does not match its saved record');

    return directory;
  });
});

function create(root: string, id: string): string {
  const tmp = path.join(root, 'tmp');
  const directory = allocate(root, id);

  if (!directoryExists(tmp)) fs.mkdirSync(tmp);

  if (!directoryExists(directory)) fs.mkdirSync(directory);

  return directory;
}

function firstLine(file: string): string | null {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

  try {
    if (!fs.fstatSync(descriptor).isFile()) return null;
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);

    for (let total = 0; total < 65536;) {
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, null);

      if (!size) return null;
      total += size;
      const newline = buffer.subarray(0, size).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline < 0 ? size : newline)));

      if (newline >= 0) return Buffer.concat(chunks).toString('utf8');
    }

    return null;
  } finally { fs.closeSync(descriptor); }
}

// The working folders of the saved chats, except the chat excluded.
function workingFolders(root: string, excluded?: string): string[] {
  const folders: string[] = [];

  for (const row of database.temporaryChatSessionRows(root)) {
    if (row.session_id === excluded) continue;
    let line;

    try { line = firstLine(row.session_path); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Cannot read the working folder from ${row.session_path}: ${error.message}`);
    }
    const cwd = line === null ? undefined : JSON.parse(line).cwd;

    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error(`Cannot read the working folder from ${row.session_path}`);
    folders.push(path.resolve(cwd));
  }

  return folders;
}

// True when a saved chat works in directory, or a queued message names it.
function inUse(root: string, folders: string[], directory: string, excluded?: string): boolean {
  return folders.some(cwd => cwd === directory || cwd.startsWith(directory + path.sep)) || database.queuedInputMentions(root, directory, excluded);
}

function removeChecked(root: string, directory: string, id: string): void {
  if (!inUse(root, workingFolders(root, id), directory, id)) remove(root, directory, id);
}

// Removes the temporary folders of deleted chats, except those in use.
function cleanupDeleted(root: string): void {
  if (!directoryExists(path.join(root, 'tmp'))) return;
  const candidates = database.orphanTemporaryChatAllocations(root);

  if (!candidates.length) return;
  const folders = workingFolders(root);
  const failures: string[] = [];

  for (const candidate of candidates) {
    const directory = candidate.original_path;

    if (!ownsFolder(root, candidate.session_id, directory) || inUse(root, folders, directory)) continue;

    try { remove(root, directory, candidate.session_id); }
    catch (error) { failures.push(`${directory}: ${error.message}`); }
  }

  if (failures.length) throw new Error(`Temporary folder cleanup failed: ${failures.join('; ')}`);
}

const forgetAllocation = onMainThread('temporary-chat.forgetAllocation', (root: string, directory: string, id: string) => {
  database.transaction(root, 'IMMEDIATE', () => {
    database.removeTemporaryChatAllocation(root, id, directory);
    database.removeReservedSessionId(root, id);
  });
});

function remove(root: string, directory: string, id: string): void {
  const allocated = database.temporaryChatFolder(root, id);
  const deleted = !database.temporaryChatSessionExists(root, id);

  if (directoryExists(directory)) {
    try {
      if (deleted && allocated === directory) fs.rmSync(directory, { recursive: true });
      else fs.rmdirSync(directory);
    }
    catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return;

      if (error.code !== 'ENOENT') throw error;
    }
  }

  forgetAllocation(root, directory, id);
}

type TemporaryChatRequest = { action: 'create'; id: string; root: string } | { action: 'remove'; path: string; root: string };

function temporaryChat(request: TemporaryChatRequest): string | null {
  if (!['create', 'remove'].includes(request.action)) throw new Error('Invalid temporary chat action');
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('Invalid temporary chat profile directory');
  const root = path.resolve(request.root);

  if (request.action === 'create' && !uuid.test(request.id)) throw new Error('Invalid temporary chat session ID');

  if (request.action === 'remove' && (typeof request.path !== 'string' || path.dirname(request.path) !== path.join(root, 'tmp'))) throw new Error('Refusing to remove a directory outside the temporary chat root');

  if (!directoryExists(root)) {
    if (request.action === 'remove') return null;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  directoryExists(path.join(root, 'tmp'));

  if (request.action === 'create') return create(root, request.id);
  const id = database.temporaryChatOwner(root, request.path);

  if (id === undefined) return null;

  if (!ownsFolder(root, id, request.path)) throw new Error('Temporary chat directory does not match its saved record');
  removeChecked(root, request.path, id);

  return null;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function folderNames(id: string): string[] {
  const hex = id.replaceAll('-', '');

  return Array.from({ length: hex.length - 3 }, (_, index) => hex.slice(0, index + 4));
}

function ownsFolder(root: string, id: string, directory: string): boolean {
  return uuid.test(id) && path.dirname(directory) === path.join(root, 'tmp') && folderNames(id).includes(path.basename(directory));
}

function list(root: string) {
  const rows = database.temporaryChatAllocations(root);

  for (const row of rows) {
    if (!ownsFolder(root, row.session_id, row.original_path)) throw new Error('Invalid saved temporary chat directory');
  }

  return rows;
}

export { temporaryChat, cleanupDeleted, list, folderNames, ownsFolder, uuid };
