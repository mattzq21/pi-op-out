const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
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

function externalHeaderIdentity(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Session transcript is not a regular file');
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, length).toString('utf8').split('\n')[0]);

    if (header.type !== 'session' || !header.id || header.id !== String(header.id)) throw new Error('Missing session identity');

    return header.id;
  } finally { fs.closeSync(descriptor); }
}

function externalIdentity(file) {
  const key = createHash('sha256').update(file).digest('hex');
  db.exec('BEGIN IMMEDIATE');

  try {
    const row = db.prepare("SELECT json_extract(record_json, '$.sessionId') AS id FROM external_transcripts WHERE record_id=? AND json_extract(record_json, '$.path')=?").get(key, file);
    const id = row ? row.id ?? externalHeaderIdentity(file) : null;

    if (row && row.id === null) db.prepare("UPDATE external_transcripts SET record_json=json_set(record_json, '$.sessionId', ?) WHERE record_id=?").run(id, key);
    db.exec('COMMIT');

    return id;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function identity(root, request) {
  const id = db.prepare(`SELECT session_id FROM sessions WHERE session_path=?`).get(request.path)?.session_id;

  const roots = [path.resolve(root), fs.realpathSync(root)];
  const managed = roots.some(directory => ['sessions', 'archived'].some(area => path.resolve(request.path).startsWith(path.join(directory, area) + path.sep)));

  if (!id && managed) throw new Error('Session path is not registered');

  return id ?? externalIdentity(request.path);
}

/** Runs one session registry request against the profile database and returns its result. */
function registryAction(request) {
  const root = request.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const database = path.join(root, 'sessions.sqlite');
  db = new DatabaseSync(database);

  try {
    fs.chmodSync(database, 0o600);
    sessionTables.initialize(db);

    if (request.action === 'reserve') return sessionTables.reserve(root);

    if (request.action === 'identity') return identity(root, request);

    if (request.action === 'ids') return db.prepare('SELECT session_id FROM sessions').all().map(record => record.session_id);

    if (request.action === 'record') return record(request);
    throw new Error('Unknown session registry action');
  } finally { db.close(); db = undefined; }
}

module.exports = { registryAction };
