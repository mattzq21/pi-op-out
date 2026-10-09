const fs = require('node:fs');
const database = require('../session-database.cjs');

const maximumBytes = 512 * 1024;

function legacy(file) {
  let descriptor;

  try {
    descriptor = fs.openSync(`${file}.loop-detection.json`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(descriptor);

    if (!info.isFile() || info.size > maximumBytes) return null;
    const buffer = Buffer.alloc(maximumBytes + 1);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);

    return size > maximumBytes ? null : buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code)) return null;
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function withDatabase(file, sessionId, operation) {
  const db = database.open(database.storageRoot(file));

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_loop_detection (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      record_json TEXT); BEGIN IMMEDIATE;`);
    const deleted = Boolean(db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(sessionId));

    if (!deleted && !db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(sessionId)) database.register(db, sessionId, file);
    const result = operation(db, deleted);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function imported(db, file, sessionId) {
  const row = db.prepare('SELECT record_json FROM session_loop_detection WHERE session_id=?').get(sessionId);

  if (row) return row.record_json;
  const body = legacy(file);
  db.prepare('INSERT INTO session_loop_detection VALUES (?, ?)').run(sessionId, body);

  return body;
}

function read(file, sessionId) {
  return withDatabase(file, sessionId, (db, deleted) => deleted ? null : imported(db, file, sessionId));
}

function update(file, sessionId, change) {
  withDatabase(file, sessionId, (db, deleted) => {
    if (deleted) throw new Error('Cannot save loop detection for a deleted session');
    const body = change(imported(db, file, sessionId));
    JSON.parse(body);

    if (Buffer.byteLength(body) > maximumBytes) throw new Error('Loop detection checkpoint exceeds its size limit');
    db.prepare('UPDATE session_loop_detection SET record_json=? WHERE session_id=?').run(body, sessionId);
  });
}

module.exports = { read, update };
