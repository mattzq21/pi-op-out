const fs = require('node:fs');
const path = require('node:path');

function initialize(db) {
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;`);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
      CREATE TABLE IF NOT EXISTS session_deletion_tombstones (session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, session_path TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session_file_metadata (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, session_path TEXT NOT NULL, modified_ns TEXT NOT NULL, size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_file_writes (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE); CREATE TRIGGER IF NOT EXISTS session_file_metadata_moved AFTER UPDATE ON sessions WHEN OLD.session_path IS NOT NEW.session_path BEGIN DELETE FROM session_file_metadata WHERE session_id=OLD.session_id; END;`);

    db.exec(`CREATE TABLE IF NOT EXISTS session_repositories (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, cwd TEXT NOT NULL,
      repository_root TEXT, remote_name TEXT, remote_url TEXT, branch TEXT, upstream_branch TEXT,
      head_commit TEXT, checked_at INTEGER NOT NULL, observed_at INTEGER, directory_exists INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_sidebar (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_child_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        complete INTEGER NOT NULL CHECK(complete IN (0, 1)));
      CREATE TABLE IF NOT EXISTS session_children (
        parent_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('subagent', 'review')),
        position INTEGER NOT NULL,
        PRIMARY KEY(parent_id, child_id));
      CREATE INDEX IF NOT EXISTS session_children_child ON session_children(child_id);
      CREATE TABLE IF NOT EXISTS session_mailbox_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_mailbox (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL, sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        message_json TEXT NOT NULL, PRIMARY KEY(session_id, delivery_id));
      CREATE INDEX IF NOT EXISTS session_mailbox_order ON session_mailbox(session_id, sequence);
      CREATE TABLE IF NOT EXISTS session_subagent_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_subagent_runs (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, started_at REAL NOT NULL, run_json TEXT NOT NULL,
        PRIMARY KEY(session_id, run_id));
      CREATE INDEX IF NOT EXISTS session_subagent_order ON session_subagent_runs(session_id, started_at);
      CREATE TABLE IF NOT EXISTS session_group_state (id INTEGER PRIMARY KEY CHECK(id=1), initialized INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_groups (
        group_id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, cwd TEXT,
        host_id TEXT, host_name TEXT, project_kind TEXT, branch TEXT);
      CREATE TABLE IF NOT EXISTS session_group_assignments (session_key TEXT PRIMARY KEY, group_id TEXT);
      CREATE TABLE IF NOT EXISTS session_group_removed_projects (project_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_group_deletions (session_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_publications (publication_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_restorations (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_restore_receipts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_candidates (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, retry_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS retention_retry_order ON retention_candidates(retry_at, record_id);
      CREATE TABLE IF NOT EXISTS cleanup_requests (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worktree_allocations (container TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_directories (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS goal_asset_dependencies (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity));
      CREATE TABLE IF NOT EXISTS goal_asset_reclamations (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queued_inputs (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fork_preparations (directory TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS archive_records (directory TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE IF NOT EXISTS deletion_records (directory TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE IF NOT EXISTS fork_transactions (directory TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE IF NOT EXISTS fork_preparation_checkpoints (preparation TEXT NOT NULL, session_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(preparation, session_id));`);

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function repositoryQuery(_db, columns, suffix = '') {
  const fields = columns.map(column => `${column === 'session_path' ? 's' : 'r'}.${column}`).join(', ');

  return `SELECT ${fields} FROM session_repositories r JOIN sessions s USING(session_id)${suffix}`;
}

function movePaths(root, moves) {
  const file = path.join(root, 'sessions.sqlite');

  if (!fs.existsSync(file)) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);

  try {
    initialize(db);
    db.exec('BEGIN IMMEDIATE');
    const move = db.prepare('UPDATE sessions SET session_path = ? WHERE session_path = ?');
    const clear = db.prepare('DELETE FROM session_sidebar WHERE session_id IN (SELECT session_id FROM sessions WHERE session_path = ?)');

    for (const item of moves) {
      clear.run(item.source);
      move.run(item.destination, item.source);
    }

    db.exec('COMMIT');
  } finally { db.close(); }
}

function register(db, sessionId, sessionPath) {
  if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(sessionId)) return;
  const previous = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId);

  if (previous?.session_path && previous.session_path !== sessionPath && require('node:fs').existsSync(previous.session_path)) {
    throw new Error(`Conversation identity has more than one transcript: ${sessionId}`);
  }

  db.prepare(`INSERT INTO sessions (session_id, session_path) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path`).run(sessionId, sessionPath);
}

function registerPath(root, sessionId, sessionPath) {
  const file = require('node:path').join(root, 'sessions.sqlite');
  const db = new (require('node:sqlite').DatabaseSync)(file);

  try {
    require('node:fs').chmodSync(file, 0o600);
    initialize(db);
    db.exec('BEGIN IMMEDIATE');
    register(db, sessionId, sessionPath);
    db.exec('COMMIT');
  } finally { db.close(); }
}

function rows(root, sql, ...parameters) {
  const db = open(root);

  try { return db.prepare(sql).all(...parameters); }
  finally { db.close(); }
}

function queuedInputs(root) { return rows(root, 'SELECT session_id, record_json FROM queued_inputs'); }

function queuedInput(root, id) {
  const db = open(root);

  try {
    const row = db.prepare('SELECT record_json FROM queued_inputs WHERE session_id=lower(?)').get(id);

    return row ? JSON.parse(row.record_json) : undefined;
  } finally { db.close(); }
}

function recoveryRecords(root) { return rows(root, 'SELECT record_id, record_json FROM recovery_directories ORDER BY record_id'); }

function saveRecoveryRecord(root, record, reserve = false) {
  const db = open(root);

  try {
    db.prepare('INSERT INTO recovery_directories VALUES (?, ?)' + (reserve ? '' : ' ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json'))
      .run(record.id, JSON.stringify(record));
  } finally { db.close(); }
}

function worktreeMetadata(container) {
  const db = open(require('node:path').dirname(require('node:path').dirname(container)));

  try {
    const row = db.prepare('SELECT metadata_json FROM worktree_allocations WHERE container=?').get(container);

    return row ? JSON.parse(row.metadata_json) : undefined;
  } finally { db.close(); }
}

function worktreeContainers(root) { return rows(root, 'SELECT container FROM worktree_allocations ORDER BY container').map(row => row.container); }

function markCleanup(root, kind) {
  const db = open(root);

  try { db.prepare('INSERT INTO cleanup_requests VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1').run(kind); }
  finally { db.close(); }
}

function cleanupRequest(root, kind) {
  const db = open(root);

  try { return db.prepare('SELECT revision FROM cleanup_requests WHERE kind=?').get(kind)?.revision; }
  finally { db.close(); }
}

function finishCleanup(root, kind, revision) {
  const db = open(root);

  try { db.prepare('DELETE FROM cleanup_requests WHERE kind=? AND revision=?').run(kind, revision); }
  finally { db.close(); }
}

function publication(root, id) {
  const row = rows(root, 'SELECT record_json FROM session_publications WHERE publication_id=?', id)[0];

  return row ? JSON.parse(row.record_json) : undefined;
}

function savePublication(root, id, record) {
  const db = open(root);

  try {
    db.prepare(`INSERT INTO session_publications VALUES (?, ?) ON CONFLICT(publication_id) DO UPDATE SET record_json=excluded.record_json`)
      .run(id, JSON.stringify(record));
  } finally { db.close(); }
}

function removePublication(root, id) {
  const db = open(root);

  try { db.prepare('DELETE FROM session_publications WHERE publication_id=?').run(id); }
  finally { db.close(); }
}

function publications(root) { return rows(root, 'SELECT publication_id FROM session_publications ORDER BY publication_id').map(row => row.publication_id); }

function open(root) {
  const file = require('node:path').join(root, 'sessions.sqlite');
  const db = new (require('node:sqlite').DatabaseSync)(file);

  try {
    require('node:fs').chmodSync(file, 0o600);
    initialize(db);

    return db;
  } catch (error) { db.close(); throw error; }
}

function lookup(root, sessionId) {
  const db = open(root);

  try {
    return db.prepare('SELECT session_path FROM sessions WHERE session_id=? AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))').get(sessionId, sessionId)?.session_path;
  } finally { db.close(); }
}

function paths(root, directory) {
  const prefix = directory === undefined ? null : path.resolve(directory) + path.sep;

  return rows(root, 'SELECT session_path FROM sessions WHERE session_path IS NOT NULL AND (? IS NULL OR substr(session_path, 1, length(?))=?) AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(sessions.session_id))', prefix, prefix, prefix).map(row => row.session_path);
}

function storageRoot(file) {
  let directory = path.dirname(file);

  while (path.dirname(directory) !== directory) {
    if (['sessions', 'archived'].includes(path.basename(directory))) return path.dirname(directory);
    directory = path.dirname(directory);
  }

  throw new Error('Conversation is outside session storage');
}

module.exports = { initialize, repositoryQuery, movePaths, register, registerPath, open, lookup, paths, storageRoot, publication, savePublication, removePublication, publications, markCleanup, cleanupRequest, finishCleanup,
  worktreeMetadata, worktreeContainers, recoveryRecords, saveRecoveryRecord, queuedInputs, queuedInput };
