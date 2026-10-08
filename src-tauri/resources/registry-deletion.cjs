const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const targetsSchema = Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String() }));

function forget(root, targets) {
  if (!Check(targetsSchema, targets) || !targets.every(target => path.isAbsolute(target.path))) throw new Error('Invalid committed deletion identities');

  const database = path.join(root, 'sessions.sqlite');

  const db = new DatabaseSync(database);

  try {
    fs.chmodSync(database, 0o600);
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS session_deletion_tombstones (session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, session_path TEXT NOT NULL);
      BEGIN IMMEDIATE;`);

    const mark = db.prepare('INSERT INTO session_deletion_tombstones VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING');

    for (const target of targets) mark.run(target.sessionId.toLowerCase(), Date.now(), target.path);

    const registry = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_repositories'").get();

    if (registry) {
      const remove = db.prepare('DELETE FROM session_repositories WHERE lower(session_id) = ?');

      for (const target of targets) remove.run(target.sessionId.toLowerCase());
    }

    db.exec('COMMIT');
  } finally { db.close(); }

  const directory = fs.openSync(root, 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
}

module.exports = { forget };
