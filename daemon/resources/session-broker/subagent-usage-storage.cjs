const fs = require('node:fs');
const database = require('../session-database.cjs');

function withDatabase(file, sessionId, operation) {
  const db = database.open(database.storageRoot(file));

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_usage_channels (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      record_json TEXT); BEGIN IMMEDIATE;`);
    const deleted = Boolean(db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(sessionId));

    const session = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId);
    const result = operation(db, deleted, session?.session_path);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function legacy(file) {
  try { return fs.readFileSync(`${file}.goal-usage.json`, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return null;
}

function read(file, sessionId) {
  return withDatabase(file, sessionId, (db, deleted, registeredPath) => {
    if (deleted || !registeredPath) return;
    let row = db.prepare('SELECT record_json FROM session_usage_channels WHERE session_id=?').get(sessionId);

    if (!row) {
      const body = legacy(registeredPath);
      db.prepare('INSERT INTO session_usage_channels VALUES (?, ?)').run(sessionId, body);
      row = { record_json: body };
    }

    if (row.record_json === null) return;

    try { return JSON.parse(row.record_json); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  });
}

function write(file, sessionId, record) {
  withDatabase(file, sessionId, (db, deleted, registeredPath) => {
    if (deleted) throw new Error('Cannot open a usage connection for a deleted session');

    if (!registeredPath) throw new Error('Usage connections require a registered session');
    db.prepare('INSERT INTO session_usage_channels VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json')
      .run(sessionId, JSON.stringify(record));
  });
}

function close(file, sessionId, token) {
  withDatabase(file, sessionId, (db, deleted) => {
    if (deleted) return;
    db.prepare("UPDATE session_usage_channels SET record_json=NULL WHERE session_id=? AND CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.token') END=?")
      .run(sessionId, token);
  });
}

module.exports = { read, write, close };
