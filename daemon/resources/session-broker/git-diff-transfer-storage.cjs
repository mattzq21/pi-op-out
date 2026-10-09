const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');

function access(transfer, hooks, operation) {
  const db = database.open(hooks.profile());

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_diff_transfers (
      session_id TEXT NOT NULL, message_id TEXT NOT NULL, transfer_id TEXT NOT NULL, body BLOB, legacy_removed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id, message_id, transfer_id)); BEGIN IMMEDIATE;`);

    if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(transfer.owner)) throw new Error('Diff transfer session was deleted');
    const key = [transfer.owner.toLowerCase(), transfer.messageId, transfer.transferId];
    const result = operation(db, key);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function legacyDirectories(file) {
  for (const directory of [path.dirname(path.dirname(file)), path.dirname(file)]) {
    try {
      if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Invalid legacy diff transfer directory; preserved');
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  return true;
}

function legacy(file, maximum) {
  if (!legacyDirectories(file)) return null;
  let fd;

  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  try {
    const metadata = fs.fstatSync(fd);

    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maximum) throw new Error('Invalid legacy diff transfer; preserved');
    const body = Buffer.alloc(metadata.size);
    let offset = 0;

    while (offset < body.length) {
      const count = fs.readSync(fd, body, offset, body.length - offset, offset);

      if (!count) throw new Error('Legacy diff transfer changed while reading; preserved');
      offset += count;
    }

    return body;
  } finally { fs.closeSync(fd); }
}

function exists(transfer, hooks, file) {
  return access(transfer, hooks, (db, key) => {
    if (db.prepare('SELECT 1 FROM session_diff_transfers WHERE session_id=? AND message_id=? AND transfer_id=?').get(...key)) return true;

    try {
      fs.lstatSync(file);

      return true;
    }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
}

function read(transfer, hooks, file) {
  const saved = access(transfer, hooks, (db, key) => {
    const row = db.prepare('SELECT body, legacy_removed FROM session_diff_transfers WHERE session_id=? AND message_id=? AND transfer_id=?').get(...key);

    if (row) return { body: row.body === null ? null : Buffer.from(row.body), removed: row.legacy_removed === 1 };
    const body = legacy(file, hooks.maxBytes);

    db.prepare('INSERT INTO session_diff_transfers (session_id, message_id, transfer_id, body) VALUES (?, ?, ?, ?)').run(...key, body);

    return { body, removed: false };
  });

  if (!saved.removed) {
    if (saved.body !== null) removeLegacy(file, saved.body, hooks.maxBytes);
    access(transfer, hooks, (db, key) => db.prepare('UPDATE session_diff_transfers SET legacy_removed=1 WHERE session_id=? AND message_id=? AND transfer_id=?').run(...key));
  }

  return saved.body;
}

function removeLegacy(file, body, maximum) {
  const previous = legacy(file, maximum);

  if (previous === null) return;

  if (!body.subarray(0, previous.length).equals(previous)) throw new Error('Legacy diff transfer changed after import; preserved');
  fs.unlinkSync(file);
  const fd = fs.openSync(path.dirname(file), 'r');

  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function status(transfer, hooks) {
  return access(transfer, hooks, (db, key) => db.prepare('SELECT length(body) AS size FROM session_diff_transfers WHERE session_id=? AND message_id=? AND transfer_id=?').get(...key));
}

function write(transfer, hooks, body) {
  if (body !== null && body.length > hooks.maxBytes) throw new Error('Permanent diff limit: staged snapshot is too large; contents preserved');
  access(transfer, hooks, (db, key) => {
    db.prepare(`INSERT INTO session_diff_transfers (session_id, message_id, transfer_id, body) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, message_id, transfer_id) DO UPDATE SET body=excluded.body`).run(...key, body);
  });
}

module.exports = { exists, read, write, status };
