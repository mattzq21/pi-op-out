const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const sessionTables = require('./session-database.cjs');

const request = JSON.parse(process.argv[1]);

const root = request.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

fs.mkdirSync(root, { recursive: true, mode: 0o700 });

const database = path.join(root, 'sessions.sqlite');

const db = new DatabaseSync(database);

fs.chmodSync(database, 0o600);

sessionTables.initialize(db);

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const optional = (cwd, args) => { try { return git(cwd, args) || null; } catch (error) { if (error.status === 1 || error.status === 128) return null; throw error; } };

function directoryExists(cwd) {
  let exists;

  try { exists = fs.statSync(cwd).isDirectory(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; exists = false; }

  return exists;
}

function selectRemote(remotes, configured) {
  if (configured && configured !== '.' && remotes.includes(configured)) return configured;

  if (remotes.includes('origin')) return 'origin';

  return remotes.length === 1 ? remotes[0] : null;
}

function upstreamBranch(cwd, branch) {
  return optional(cwd, ['config', '--get', `branch.${branch}.merge`])?.replace(/^refs\/heads\//, '') || null;
}

function repositoryState(cwd, exists) {
  let repository = null, remote = null, url = null, branch = null, upstream = null, head = null;

  if (exists) {
    try { repository = git(cwd, ['rev-parse', '--show-toplevel']); }
    catch (error) { if (!String(error.stderr).includes('not a git repository')) throw error; }

    if (repository) {
      branch = optional(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      head = optional(cwd, ['rev-parse', '--verify', 'HEAD']);
      const remotes = git(cwd, ['remote']).split('\n').filter(Boolean);
      const configured = branch && optional(cwd, ['config', '--get', `branch.${branch}.remote`]);
      remote = selectRemote(remotes, configured);
      url = remote ? git(cwd, ['remote', 'get-url', remote]) : null;
      upstream = branch && configured === remote ? upstreamBranch(cwd, branch) : null;
    }
  }

  return { repository, remote, url, branch, upstream, head };
}

function registeredSession(session) {
  if (!path.isAbsolute(session.sessionPath || '')) return false;

  return Boolean(db.prepare(`SELECT 1 FROM sessions WHERE session_id=? AND session_path=?
    AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))`)
    .get(session.sessionId, session.sessionPath, session.sessionId));
}

function insertRecord(session, checked, exists, state) {
  const { repository, remote, url, branch, upstream, head } = state;

  if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id = lower(?)').get(session.sessionId)) return;
  db.prepare(`INSERT INTO session_repositories SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id = lower(?))
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd,
      repository_root=CASE WHEN excluded.directory_exists THEN excluded.repository_root ELSE repository_root END,
      remote_name=CASE WHEN excluded.directory_exists THEN excluded.remote_name ELSE remote_name END,
      remote_url=CASE WHEN excluded.directory_exists THEN excluded.remote_url ELSE remote_url END,
      branch=CASE WHEN excluded.directory_exists THEN excluded.branch ELSE branch END,
      upstream_branch=CASE WHEN excluded.directory_exists THEN excluded.upstream_branch ELSE upstream_branch END,
      head_commit=CASE WHEN excluded.directory_exists THEN excluded.head_commit ELSE head_commit END,
      checked_at=excluded.checked_at,
      observed_at=CASE WHEN excluded.directory_exists THEN excluded.observed_at ELSE observed_at END,
      directory_exists=excluded.directory_exists
    WHERE excluded.checked_at >= session_repositories.checked_at
      AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id = lower(excluded.session_id))`).run(
    session.sessionId, session.cwd, repository, remote, url, branch, upstream, head, checked, exists ? checked : null, Number(exists), session.sessionId);
}

function record(session) {
  if (!session.sessionId || !path.isAbsolute(session.cwd || '') || !registeredSession(session)) return;
  const checked = session.checkedAt || Date.now();
  const exists = directoryExists(session.cwd);
  const state = repositoryState(session.cwd, exists);
  db.exec('BEGIN IMMEDIATE');

  try {
    if (registeredSession(session)) insertRecord(session, checked, exists, state);
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
      AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones t WHERE t.session_id=lower(sessions.session_id))
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
  sessionTables.importSessions(db, root);
  const directory = path.join(root, 'sessions') + path.sep;

  const rows = db.prepare(`SELECT s.session_path, m.modified_ns, m.size FROM sessions s LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path WHERE s.session_path IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones t WHERE t.session_id=lower(s.session_id))`).all();

  for (const row of rows) {
    if (!row.session_path.startsWith(directory)) continue;
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
  sessionTables.importSessions(db, root);

  const id = db.prepare(`SELECT session_id FROM sessions WHERE session_path=?
    AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(sessions.session_id))`).get(request.path)?.session_id;

  const roots = [path.resolve(root), fs.realpathSync(root)];
  const managed = roots.some(directory => ['sessions', 'archived'].some(area => path.resolve(request.path).startsWith(path.join(directory, area) + path.sep)));

  if (!id && managed) throw new Error('Session path is not registered');

  process.stdout.write(JSON.stringify(id ?? externalIdentity(request.path)));
}

try {
  if (request.action === 'initialize') sessionTables.importSessions(db, root);
  else if (request.action === 'metadata') metadata();
  else if (request.action === 'identity') identity();
  else if (request.action === 'get') process.stdout.write(JSON.stringify(db.prepare('SELECT r.*, s.session_path FROM session_repositories r JOIN sessions s USING(session_id) WHERE r.session_id = ?').get(request.sessionId) || null));
  else if (request.action === 'deleted') process.stdout.write(JSON.stringify(db.prepare('SELECT session_id FROM session_deletion_tombstones').all().map(record => record.session_id)));
  else if (request.action === 'scan') sessionTables.importSessions(db, root);
  else if (request.action === 'record') record(request);
  else throw new Error('Unknown session registry action');
} finally { db.close(); }
