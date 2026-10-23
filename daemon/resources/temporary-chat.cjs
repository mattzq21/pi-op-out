const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

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

function create(db, root, directory, id) {
  const reserve = db.prepare('INSERT INTO temporary_chat_allocations (session_id, original_path) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING');
  reserve.run(id, directory);
  db.exec('BEGIN IMMEDIATE');
  reserve.run(id, directory);
  const saved = db.prepare('SELECT original_path FROM temporary_chat_allocations WHERE session_id=?').get(id);

  if (saved.original_path !== directory) throw new Error('Temporary chat directory does not match its saved record');

  if (!directoryExists(path.join(root, 'tmp'))) fs.mkdirSync(path.join(root, 'tmp'));

  if (!directoryExists(directory)) fs.mkdirSync(directory);
  sync(path.join(root, 'tmp'));
  sync(root);
}

function firstLine(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

  try {
    if (!fs.fstatSync(descriptor).isFile()) return null;
    const chunks = [];
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

function references(db, excluded) {
  const version = db.prepare('PRAGMA data_version').get().data_version;
  const rows = db.prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL').all();
  const directories = [];

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

  const queued = db.prepare(`SELECT session_id, cwd || COALESCE(session_path, '') AS text FROM queue_origins UNION ALL SELECT session_id, message || details_json AS text FROM queue_items UNION ALL SELECT q.session_id, a.details_json AS text FROM queue_attachments a JOIN queue_items q USING(queue_item_id)`).all().filter(row => row.session_id !== excluded).map(row => row.text);

  return { version, directories, queued };
}

function inUse(snapshot, directory) {
  return snapshot.directories.some(cwd => cwd === directory || cwd.startsWith(directory + path.sep))
    || snapshot.queued.some(body => body.includes(directory));
}

function removeChecked(db, directory, id) {
  const snapshot = references(db, id);

  if (snapshot.deferred) console.error(snapshot.deferred);
  db.exec('BEGIN IMMEDIATE');

  if (snapshot.deferred || db.prepare('PRAGMA data_version').get().data_version !== snapshot.version || inUse(snapshot, directory)) return;
  remove(db, directory, id);
}

function cleanupDeleted(root) {
  if (!directoryExists(path.join(root, 'tmp'))) return;
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE)');
    const candidates = db.prepare('SELECT a.session_id, a.original_path FROM temporary_chat_allocations a WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=a.session_id)').all();

    if (!candidates.length) return;
    const snapshot = references(db);

    if (snapshot.deferred) throw new Error(snapshot.deferred);
    db.exec('BEGIN IMMEDIATE');

    if (db.prepare('PRAGMA data_version').get().data_version !== snapshot.version) {
      db.exec('ROLLBACK');
      throw new Error('Temporary folder cleanup deferred: session storage changed while references were checked');
    }

    const failures = removeCandidates(db, root, snapshot, candidates);
    db.exec('COMMIT');

    if (failures.length) throw new Error(`Temporary folder cleanup failed: ${failures.join('; ')}`);
    const pending = db.prepare('SELECT a.original_path FROM temporary_chat_allocations a WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=a.session_id)').all().map(row => row.original_path).filter(directory => !inUse(snapshot, directory));

    return pending.length ? { pending: true, warning: `Temporary folder cleanup deferred: ${pending.join('; ')}` } : { pending: false };
  } finally { db.close(); }
}

function removeCandidates(db, root, snapshot, candidates) {
  const failures = [];

  for (const candidate of candidates) {
    const directory = path.join(root, 'tmp', candidate.session_id);

    if (candidate.original_path !== directory || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidate.session_id) || inUse(snapshot, directory)) continue;

    try { remove(db, directory, candidate.session_id); }
    catch (error) { failures.push(`${directory}: ${error.message}`); }
  }

  return failures;
}

function remove(db, directory, id) {
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
  db.prepare('DELETE FROM temporary_chat_allocations WHERE session_id=? AND original_path=?').run(id, directory);
  db.prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(id);
}

/** Creates or removes one temporary chat directory in the profile at request.root. Returns the directory for create, or null for remove. */
function temporaryChat(request) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.id)) throw new Error('Invalid temporary chat session ID');

  if (!['create', 'remove'].includes(request.action)) throw new Error('Invalid temporary chat action');
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('Invalid temporary chat profile directory');
  const root = path.resolve(request.root);
  const directory = path.join(root, 'tmp', request.id);

  if (request.action === 'remove' && request.path !== directory) throw new Error('Refusing to remove a directory outside the temporary chat root');

  if (!directoryExists(root)) {
    if (request.action === 'remove') return null;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  directoryExists(path.join(root, 'tmp'));
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE)');

    if (request.action === 'create') create(db, root, directory, request.id);
    else removeChecked(db, directory, request.id);
    db.exec('COMMIT');
  } finally { db.close(); }

  return request.action === 'create' ? directory : null;
}

module.exports = { temporaryChat, cleanupDeleted };
