import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as database from './session-database.ts';
import { onMainThread } from './main-thread.ts';
import { folderNames, ownsFolder, uuid } from './temporary-chat-inventory.ts';

function directoryExists(directory) {
  try {
    const info = fs.lstatSync(directory);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Temporary chat path must be a directory, not a link');

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sync(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

// Saves which folder belongs to the temporary chat id, or returns the one it has.
const allocate = onMainThread('temporary-chat.allocate', (root: string, id: string) => {
  const db = database.connection(root);

  return database.transaction(db, 'IMMEDIATE', () => {
    let directory = (db.prepare('SELECT original_path FROM temporary_chat_allocations WHERE session_id=?').get(id) as { original_path: string } | undefined)?.original_path;

    if (directory === undefined) {
      const taken = db.prepare('SELECT 1 FROM temporary_chat_allocations WHERE original_path=?');
      directory = folderNames(id).map(name => path.join(root, 'tmp', name)).find(candidate => !taken.get(candidate) && !directoryExists(candidate));

      if (directory === undefined) throw new Error('Every folder name for this temporary chat is in use');
      db.prepare('INSERT INTO temporary_chat_allocations (session_id, original_path) VALUES (?, ?)').run(id, directory);
    } else if (!ownsFolder(root, id, directory)) throw new Error('Temporary chat directory does not match its saved record');

    return directory;
  });
});

function create(root, id) {
  const tmp = path.join(root, 'tmp');
  const directory = allocate(root, id);

  if (!directoryExists(tmp)) fs.mkdirSync(tmp);

  if (!directoryExists(directory)) fs.mkdirSync(directory);
  sync(tmp);
  sync(root);

  return directory;
}

function firstLine(file) {
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

function deferReference(file, reason) {
  return { deferred: `Temporary folder cleanup deferred: cannot read the working folder from ${file}: ${reason}` };
}

const queuedText = `SELECT session_id, cwd || COALESCE(session_path, '') AS text FROM queue_origins UNION ALL SELECT session_id, message || details_json AS text FROM queue_items UNION ALL SELECT q.session_id, a.details_json AS text FROM queue_attachments a JOIN queue_items q USING(queue_item_id)`;

// The saved chats and queued messages that the references come from. When it is unchanged, so are the references.
function referenceVersion(db) {
  const rows = db.prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL ORDER BY session_id').all();

  return createHash('sha256').update(JSON.stringify([rows, db.prepare(queuedText).all()])).digest('hex');
}

const unchanged = onMainThread('temporary-chat.unchanged', (root: string, version: string) => referenceVersion(database.connection(root)) === version);

type ReferenceSnapshot = { deferred: string; version?: undefined } | { deferred?: undefined; version: string; directories: string[]; queued: string[] };

function references(db, excluded?): ReferenceSnapshot {
  const version = referenceVersion(db);
  const rows = db.prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL').all();
  const directories: string[] = [];

  for (const row of rows) {
    if (row.session_id === excluded) continue;

    try {
      const line = firstLine(row.session_path);

      if (line === null) return deferReference(row.session_path, 'missing, oversized, or non-regular chat header');
      const cwd = JSON.parse(line).cwd;

      if (!path.isAbsolute(cwd)) return deferReference(row.session_path, 'working folder path is not absolute');
      directories.push(path.resolve(cwd));
    } catch (error) {
      if (error.code === 'ENOENT') continue;

      return deferReference(row.session_path, error.message);
    }
  }

  const queued = (db.prepare(queuedText).all() as { session_id: string; text: string }[]).filter(row => row.session_id !== excluded).map(row => row.text);

  return { version, directories, queued };
}

function inUse(snapshot, directory) {
  return snapshot.directories.some(cwd => cwd === directory || cwd.startsWith(directory + path.sep))
    || snapshot.queued.some(body => body.includes(directory));
}

function removeChecked(root, db, directory, id) {
  const snapshot = references(db, id);

  if (snapshot.deferred) console.error(snapshot.deferred);

  if (snapshot.deferred !== undefined || inUse(snapshot, directory) || !unchanged(root, snapshot.version)) return;
  remove(root, db, directory, id);
}

function cleanupDeleted(root) {
  if (!directoryExists(path.join(root, 'tmp'))) return;
  const db = database.connection(root);
  const candidates = db.prepare('SELECT a.session_id, a.original_path FROM temporary_chat_allocations a WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=a.session_id)').all();

  if (!candidates.length) return;
  const snapshot = references(db);

  if (snapshot.deferred !== undefined) throw new Error(snapshot.deferred);
  if (!unchanged(root, snapshot.version)) throw new Error('Temporary folder cleanup deferred: session storage changed while references were checked');
  const failures = removeCandidates(db, root, snapshot, candidates);

  if (failures.length) throw new Error(`Temporary folder cleanup failed: ${failures.join('; ')}`);
  const pending = db.prepare('SELECT a.original_path FROM temporary_chat_allocations a WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=a.session_id)').all().map(row => row.original_path).filter(directory => !inUse(snapshot, directory));

  return pending.length ? { pending: true, warning: `Temporary folder cleanup deferred: ${pending.join('; ')}` } : { pending: false };
}

function removeCandidates(db, root, snapshot, candidates) {
  const failures: string[] = [];

  for (const candidate of candidates) {
    const directory = candidate.original_path;

    if (!ownsFolder(root, candidate.session_id, directory) || inUse(snapshot, directory)) continue;

    try { remove(root, db, directory, candidate.session_id); }
    catch (error) { failures.push(`${directory}: ${error.message}`); }
  }

  return failures;
}

const forgetAllocation = onMainThread('temporary-chat.forgetAllocation', (root: string, directory: string, id: string) => {
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    db.prepare('DELETE FROM temporary_chat_allocations WHERE session_id=? AND original_path=?').run(id, directory);
    db.prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(id);
  });
});

function remove(root, db, directory, id) {
  const allocation = db.prepare('SELECT original_path FROM temporary_chat_allocations WHERE session_id=?').get(id);
  const deleted = !db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id);

  if (directoryExists(directory)) {
    try {
      if (deleted && allocation?.original_path === directory) fs.rmSync(directory, { recursive: true });
      else fs.rmdirSync(directory);
    }
    catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return;

      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (directoryExists(path.dirname(directory))) sync(path.dirname(directory));
  forgetAllocation(root, directory, id);
}

function temporaryChat(request) {
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
  const db = database.connection(root);

  if (request.action === 'create') return create(root, request.id);
  const id = db.prepare('SELECT session_id FROM temporary_chat_allocations WHERE original_path=?').get(request.path)?.session_id;

  if (id === undefined) return null;

  if (!ownsFolder(root, id, request.path)) throw new Error('Temporary chat directory does not match its saved record');
  removeChecked(root, db, request.path, id);

  return null;
}

export { temporaryChat, cleanupDeleted };
