const fs = require('node:fs');
const { serialize, deserialize } = require('node:v8');
const database = require('./session-database.cjs');

function fingerprint(file) {
  const info = fs.lstatSync(file, { bigint: true });

  if (!info.isFile()) throw new Error('Storage report transcript is not a regular file');

  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function open(root) {
  const db = database.open(root);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS storage_transcript_summaries (session_path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body BLOB NOT NULL);
      CREATE TRIGGER IF NOT EXISTS storage_transcript_summaries_moved AFTER UPDATE OF session_path ON sessions
      WHEN OLD.session_path IS NOT NEW.session_path BEGIN
        DELETE FROM storage_transcript_summaries WHERE session_path=OLD.session_path;
      END;
      CREATE TRIGGER IF NOT EXISTS storage_transcript_summaries_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM storage_transcript_summaries WHERE session_path=OLD.session_path;
      END;`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function saved(db, file, stamp) {
  const row = db.prepare('SELECT body FROM storage_transcript_summaries WHERE session_path=? AND fingerprint=?').get(file, stamp);

  if (!row) return;

  try {
    const stored = deserialize(row.body);

    if (stored?.version === 2) return stored.value;
  } catch { }
}

function save(db, file, stamp, value) {
  db.exec('BEGIN IMMEDIATE');

  try {
    if (fingerprint(file) === stamp) db.prepare('INSERT INTO storage_transcript_summaries VALUES (?, ?, ?) ON CONFLICT(session_path) DO UPDATE SET fingerprint=excluded.fingerprint, body=excluded.body')
      .run(file, stamp, serialize({ version: 2, value }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function read(db, file, inspect) {
  const stamp = fingerprint(file);
  const previous = saved(db, file, stamp);

  if (previous && fingerprint(file) === stamp) return previous;
  const value = await inspect();

  if (fingerprint(file) !== stamp) throw new Error('Transcript changed while preparing the storage report');
  save(db, file, stamp, value);

  return value;
}

async function withCache(root, operation) {
  let db;

  try { return await operation((file, inspect) => read(db ??= open(root), file, inspect)); }
  finally { db?.close(); }
}

module.exports = { withCache };
