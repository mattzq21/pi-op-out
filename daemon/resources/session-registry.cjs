const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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

function savedSession(session) {
  if (!path.isAbsolute(session.sessionPath || '')) return false;
  let file;

  try { file = fs.openSync(session.sessionPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }

  try {
    if (!fs.fstatSync(file).isFile()) return false;
    const buffer = Buffer.alloc(65536);
    const count = fs.readSync(file, buffer);
    const header = JSON.parse(buffer.subarray(0, count).toString().split('\n')[0]);

    return header?.type === 'session' && header.id === session.sessionId;
  } finally { fs.closeSync(file); }
}

function insertRecord(session, checked, exists, state) {
  const { repository, remote, url, branch, upstream, head } = state;

  if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id = lower(?)').get(session.sessionId)) return;
  sessionTables.register(db, session.sessionId, session.sessionPath);
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
  if (!session.sessionId || !path.isAbsolute(session.cwd || '') || !savedSession(session)) return;
  const checked = session.checkedAt || Date.now();
  const exists = directoryExists(session.cwd);
  const state = repositoryState(session.cwd, exists);
  db.exec('BEGIN IMMEDIATE');

  try {
    if (savedSession(session)) insertRecord(session, checked, exists, state);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}


function metadata() {
  sessionTables.importSessions(db, root);
  const directory = path.join(root, 'sessions') + path.sep;

  const rows = db.prepare(`SELECT session_path FROM sessions WHERE session_path IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones t WHERE t.session_id=lower(sessions.session_id))`).all();

  for (const row of rows) {
    if (!row.session_path.startsWith(directory)) continue;
    let stat;

    try { stat = fs.lstatSync(row.session_path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    if (!stat.isFile()) continue;
    const modified = `${stat.mtimeNs / 1000000000n}.${String(stat.mtimeNs % 1000000000n).padStart(9, '0')}`;
    process.stdout.write(`${row.session_path}\0${modified}\0${stat.size}\0`);
  }
}

try {
  if (request.action === 'initialize') sessionTables.importSessions(db, root);
  else if (request.action === 'metadata') metadata();
  else if (request.action === 'get') process.stdout.write(JSON.stringify(db.prepare('SELECT r.*, s.session_path FROM session_repositories r JOIN sessions s USING(session_id) WHERE r.session_id = ?').get(request.sessionId) || null));
  else if (request.action === 'deleted') process.stdout.write(JSON.stringify(db.prepare('SELECT session_id FROM session_deletion_tombstones').all().map(record => record.session_id)));
  else if (request.action === 'scan') sessionTables.importSessions(db, root);
  else if (request.action === 'record') record(request);
  else throw new Error('Unknown session registry action');
} finally { db.close(); }
