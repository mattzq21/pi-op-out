const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const targetsSchema = Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String() }));

function removeSessionRecords(db, targets) {
  for (const table of ['chat_notes', 'note_editor_leases', 'transcript_references']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const remove = db.prepare(`DELETE FROM ${table} WHERE session_id=lower(?)`);

    for (const target of targets) remove.run(target.sessionId);
  }
}

function forget(root, targets) {
  if (!Check(targetsSchema, targets) || !targets.every(target => path.isAbsolute(target.path))) throw new Error('Invalid committed deletion identities');

  const database = path.join(root, 'sessions.sqlite');

  const db = new DatabaseSync(database);

  try {
    fs.chmodSync(database, 0o600);
    require('./session-database.cjs').initialize(db);
    db.exec('BEGIN IMMEDIATE');

    const mark = db.prepare('INSERT INTO session_deletion_tombstones VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING');

    for (const target of targets) {
      mark.run(target.sessionId.toLowerCase(), Date.now(), target.path);
      db.prepare('DELETE FROM queued_inputs WHERE session_id=lower(?)').run(target.sessionId);
    }

    removeSessionRecords(db, targets);

    for (const target of targets) db.prepare('DELETE FROM sessions WHERE lower(session_id) = ?').run(target.sessionId.toLowerCase());

    db.exec('COMMIT');
  } finally { db.close(); }

  const directory = fs.openSync(root, 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
}

module.exports = { forget };
