const database = require('../session-database.cjs');

const maximumBytes = 512 * 1024;

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

function stored(db, sessionId) {
  const row = db.prepare('SELECT record_json FROM session_loop_detection WHERE session_id=?').get(sessionId);

  if (row) return row.record_json;
  const body = null;
  db.prepare('INSERT INTO session_loop_detection VALUES (?, ?)').run(sessionId, body);

  return body;
}

function read(file, sessionId) {
  return withDatabase(file, sessionId, (db, deleted) => deleted ? null : stored(db, sessionId));
}

function update(file, sessionId, change) {
  withDatabase(file, sessionId, (db, deleted) => {
    if (deleted) throw new Error('Cannot save loop detection for a deleted session');
    const body = change(stored(db, sessionId));
    JSON.parse(body);

    if (Buffer.byteLength(body) > maximumBytes) throw new Error('Loop detection checkpoint exceeds its size limit');
    db.prepare('UPDATE session_loop_detection SET record_json=? WHERE session_id=?').run(body, sessionId);
  });
}

module.exports = { read, update };
