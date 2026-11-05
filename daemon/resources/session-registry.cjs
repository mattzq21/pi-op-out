const fs = require('node:fs');
const path = require('node:path');
const sessionTables = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');

function directoryExists(cwd) {
  let exists;

  try { exists = fs.statSync(cwd).isDirectory(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; exists = false; }

  return exists;
}

function registeredSession(db, session) {
  if (!path.isAbsolute(session.sessionPath || '')) return false;

  return Boolean(db.prepare(`SELECT 1 FROM sessions WHERE session_id=? AND session_path=?`)
    .get(session.sessionId, session.sessionPath));
}

function insertRecord(db, session, checked, exists) {
  db.prepare(`INSERT INTO session_directories (session_id, cwd, checked_at, directory_exists) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, checked_at=excluded.checked_at, directory_exists=excluded.directory_exists
    WHERE excluded.checked_at >= session_directories.checked_at`).run(session.sessionId, session.cwd, checked, Number(exists));
}

const saveDirectory = onMainThread('session-registry.saveDirectory', (root, session, checked, exists) => {
  const db = sessionTables.connection(root);

  sessionTables.transaction(db, 'IMMEDIATE', () => {
    if (registeredSession(db, session)) insertRecord(db, session, checked, exists);
  });
});

// Checks the folder of a chat, which can be slow on a network folder, and saves whether it exists.
function recordDirectory(request) {
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('Invalid session registry root');
  const session = { sessionId: request.sessionId, sessionPath: request.sessionPath, cwd: request.cwd };

  if (!session.sessionId || !path.isAbsolute(session.cwd || '') || !registeredSession(sessionTables.connection(request.root), session)) return null;
  saveDirectory(request.root, session, request.checkedAt || Date.now(), directoryExists(session.cwd));

  return null;
}

function sessionPath(root, id) {
  return sessionTables.connection(root).prepare('SELECT session_path FROM sessions WHERE session_id=?').get(id)?.session_path;
}

module.exports = { recordDirectory, sessionPath };
