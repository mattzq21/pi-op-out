const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Snapshot directory changed');

  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

function root(directory) {
  let current = directory;

  while (path.dirname(current) !== current) {
    if (['sessions', 'archived', 'git-snapshots'].includes(path.basename(current))) return path.dirname(current);
    current = path.dirname(current);
  }

  throw new Error('Snapshot is outside Piop storage');
}

function withDatabase(directory, operation) {
  const db = database.open(root(directory));

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS snapshot_metadata (
      identity TEXT PRIMARY KEY, session_id TEXT, record_json TEXT); BEGIN IMMEDIATE;`);
    const result = operation(db);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function legacy(directory) {
  try { return fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return null;
}

function read(directory) {
  let key;

  try { key = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  return withDatabase(directory, db => {
    let row = db.prepare('SELECT record_json FROM snapshot_metadata WHERE identity=?').get(key);

    if (!row) {
      const body = legacy(directory);

      if (identity(directory) !== key) throw new Error('Snapshot directory changed during import');
      const sessionId = body === null ? null : JSON.parse(body).sessionId ?? null;
      db.prepare('INSERT INTO snapshot_metadata VALUES (?, ?, ?)').run(key, sessionId, body);
      row = { record_json: body };
    }

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  });
}

function write(directory, record) {
  const key = identity(directory);
  withDatabase(directory, db => {
    if (record.sessionId && db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(record.sessionId)) throw new Error('Cannot save a snapshot for a deleted session');
    db.prepare('INSERT INTO snapshot_metadata VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET session_id=excluded.session_id, record_json=excluded.record_json')
      .run(key, record.sessionId ?? null, JSON.stringify(record));
  });
}

function copy(source, destination) {
  const saved = read(source);

  if (saved !== undefined) write(destination, saved);
}

function identities(profile) {
  const db = database.open(profile);

  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshot_metadata'").get()) return [];

    return db.prepare('SELECT identity FROM snapshot_metadata WHERE record_json IS NOT NULL').all().map(row => row.identity);
  } finally { db.close(); }
}

module.exports = { identity, read, write, copy, identities };
