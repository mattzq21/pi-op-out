const { createHash } = require('node:crypto');
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

function registerExternalTranscript(root, transcript, sessionId) {
  if (!transcript) return;
  const file = path.resolve(transcript);
  const relative = path.relative(root, file);

  if (["sessions", "archived"].some(area => relative.startsWith(area + path.sep))) return;
  const databasePath = path.join(root, "sessions.sqlite");
  if (fs.lstatSync(databasePath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Database path must not be a symbolic link");
  const database = new DatabaseSync(databasePath);

  try {
    fs.chmodSync(databasePath, 0o600);
    database.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    database.prepare("INSERT INTO external_transcripts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=json_patch(external_transcripts.record_json, excluded.record_json)")
      .run(createHash("sha256").update(file).digest("hex"), JSON.stringify({ path: file, sessionId }));
  } finally { database.close(); }
}

function saveManagedMetadata(database, id, file, saved) {
  database.prepare("DELETE FROM session_file_metadata WHERE session_id=?").run(id);

  if (!saved) {
    database.prepare("INSERT INTO session_file_writes VALUES (?) ON CONFLICT DO NOTHING").run(id);

    return;
  }

  const metadata = fs.lstatSync(file, { bigint: true });

  if (!metadata.isFile()) throw new Error("Saved session is not a regular file");
  database.prepare("INSERT INTO session_file_metadata VALUES (?, ?, ?, ?)").run(id, file, String(metadata.mtimeNs), metadata.size);
  database.prepare("DELETE FROM session_file_writes WHERE session_id=?").run(id);
}

function withRegistry(root, operation) {
  const database = sessionTables.open(root);
  try { return operation(database); } finally { database.close(); }
}

function bindSession(root, id, file) {
  return withRegistry(root, database => sessionTables.bind(database, id, file));
}

function requireSession(root, id, file) {
  return withRegistry(root, database => sessionTables.register(database, id, file));
}

function recordTranscript(root, id, file, saved) {
  return withRegistry(root, database => {
    database.exec('BEGIN IMMEDIATE');
    sessionTables.register(database, id, file);
    saveManagedMetadata(database, id, file, saved);
    database.exec('COMMIT');
  });
}

function sessionPath(root, id) {
  return withRegistry(root, database => database.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(id)?.session_path);
}

module.exports = { recordDirectory, bindSession, requireSession, recordTranscript, sessionPath, registerExternalTranscript };
