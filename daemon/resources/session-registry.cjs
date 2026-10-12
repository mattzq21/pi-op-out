const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sessionTables = require('./session-database.cjs');

let db;

function directoryExists(cwd) {
  let exists;

  try { exists = fs.statSync(cwd).isDirectory(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; exists = false; }

  return exists;
}

function registeredSession(session) {
  if (!path.isAbsolute(session.sessionPath || '')) return false;

  return Boolean(db.prepare(`SELECT 1 FROM sessions WHERE session_id=? AND session_path=?`)
    .get(session.sessionId, session.sessionPath));
}

function insertRecord(session, checked, exists) {
  db.prepare(`INSERT INTO session_directories (session_id, cwd, checked_at, directory_exists) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, checked_at=excluded.checked_at, directory_exists=excluded.directory_exists
    WHERE excluded.checked_at >= session_directories.checked_at`).run(session.sessionId, session.cwd, checked, Number(exists));
}

function record(session) {
  if (!session.sessionId || !path.isAbsolute(session.cwd || '') || !registeredSession(session)) return;
  const checked = session.checkedAt || Date.now();
  const exists = directoryExists(session.cwd);

  db.exec('BEGIN IMMEDIATE');

  try {
    if (registeredSession(session)) insertRecord(session, checked, exists);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Records the working directory of a registered session in the registry at request.root. */
function recordDirectory(request) {
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('Invalid session registry root');
  const root = request.root;

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const database = path.join(root, 'sessions.sqlite');
  db = new DatabaseSync(database);

  try {
    fs.chmodSync(database, 0o600);
    sessionTables.initialize(db);
    record(request);

    return null;
  } finally { db.close(); db = undefined; }
}

module.exports = { recordDirectory };
