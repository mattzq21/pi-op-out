const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sessionTables = require('./session-database.cjs');

const request = JSON.parse(process.argv[1]);

const root = request.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

fs.mkdirSync(root, { recursive: true, mode: 0o700 });

const database = path.join(root, 'sessions.sqlite');

const db = new DatabaseSync(database);

fs.chmodSync(database, 0o600);

sessionTables.initialize(db);

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

function registeredMetadata(row) {
  if (row.modified_ns !== null && row.size !== null) return { mtimeNs: BigInt(row.modified_ns), size: row.size };
  db.exec('BEGIN IMMEDIATE');

  try {
    const stat = readMetadata(row.session_path);

    if (stat) db.prepare(`INSERT INTO session_file_metadata SELECT session_id, session_path, ?, ? FROM sessions WHERE session_path=?
      AND NOT EXISTS (SELECT 1 FROM session_file_writes w WHERE w.session_id=sessions.session_id)
      ON CONFLICT(session_id) DO NOTHING`).run(String(stat.mtimeNs), stat.size, row.session_path);
    db.exec('COMMIT');

    return stat;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function readMetadata(file) {
  let stat;

  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  return stat.isFile() ? stat : undefined;
}

function metadata() {
  const directory = path.join(root, 'sessions') + path.sep;

  const rows = db.prepare(`SELECT s.session_path, m.modified_ns, m.size FROM sessions s LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path WHERE substr(s.session_path, 1, length(?))=?`).all(directory, directory);

  for (const row of rows) {
    const stat = registeredMetadata(row);

    if (!stat) continue;
    const modified = `${stat.mtimeNs / 1000000000n}.${String(stat.mtimeNs % 1000000000n).padStart(9, '0')}`;
    process.stdout.write(`${row.session_path}\0${modified}\0${stat.size}\0`);
  }
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

function identity() {

  const id = db.prepare(`SELECT session_id FROM sessions WHERE session_path=?`).get(request.path)?.session_id;

  const roots = [path.resolve(root), fs.realpathSync(root)];
  const managed = roots.some(directory => ['sessions', 'archived'].some(area => path.resolve(request.path).startsWith(path.join(directory, area) + path.sep)));

  if (!id && managed) throw new Error('Session path is not registered');

  process.stdout.write(JSON.stringify(id ?? externalIdentity(request.path)));
}

try {
  if (request.action === 'initialize') sessionTables.initialize(db);
  else if (request.action === 'reserve') process.stdout.write(JSON.stringify(sessionTables.reserve(root)));
  else if (request.action === 'metadata') metadata();
  else if (request.action === 'identity') identity();
  else if (request.action === 'get') process.stdout.write(JSON.stringify(db.prepare('SELECT r.*, s.session_path FROM session_directories r JOIN sessions s USING(session_id) WHERE r.session_id = ?').get(request.sessionId) || null));
  else if (request.action === 'ids') process.stdout.write(JSON.stringify(db.prepare('SELECT session_id FROM sessions').all().map(record => record.session_id)));
  else if (request.action === 'record') record(request);
  else throw new Error('Unknown session registry action');
} finally { db.close(); }
