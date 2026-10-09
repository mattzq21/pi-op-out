const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Comparison directory changed');

  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

function withDatabase(root, operation) {
  const db = database.open(root);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS snapshot_comparison_records (
      identity TEXT PRIMARY KEY, session_id TEXT NOT NULL, record_json TEXT); BEGIN IMMEDIATE;`);
    const result = operation(db);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function legacy(directory) {
  try { return fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return null;
}

function read(root, directory, sessionId) {
  const key = identity(directory);

  return withDatabase(root, db => {
    let row = db.prepare('SELECT session_id, record_json FROM snapshot_comparison_records WHERE identity=?').get(key);

    if (!row) {
      const body = legacy(directory);

      if (identity(directory) !== key) throw new Error('Comparison directory changed during import');
      db.prepare('INSERT INTO snapshot_comparison_records VALUES (?, ?, ?)').run(key, sessionId, body);
      row = { session_id: sessionId, record_json: body };
    }

    if (row.session_id !== sessionId) throw new Error('Comparison session identity changed');

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  });
}

function write(root, directory, record) {
  const key = identity(directory);
  withDatabase(root, db => {
    if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(record.sessionId)) throw new Error('Cannot save a comparison for a deleted session');
    db.prepare('INSERT INTO snapshot_comparison_records VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET session_id=excluded.session_id, record_json=excluded.record_json')
      .run(key, record.sessionId, JSON.stringify(record));
  });
}

function remove(root, key) {
  withDatabase(root, db => db.prepare('DELETE FROM snapshot_comparison_records WHERE identity=?').run(key));
}

module.exports = { identity, read, write, remove };
