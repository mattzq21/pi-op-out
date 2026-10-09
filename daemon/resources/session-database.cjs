const fs = require('node:fs');
const path = require('node:path');

function initialize(db) {
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;`);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT);
      CREATE TABLE IF NOT EXISTS session_deletion_tombstones (session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, session_path TEXT NOT NULL);`);
    const columns = db.prepare('PRAGMA table_info(session_repositories)').all();

    if (columns.some(column => column.name === 'session_path')) {
      db.exec(`INSERT INTO sessions SELECT session_id, session_path FROM session_repositories WHERE true ON CONFLICT(session_id) DO NOTHING;
        ALTER TABLE session_repositories RENAME TO session_repositories_previous;`);
    }

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
      CREATE TABLE IF NOT EXISTS snapshot_recovery (directory TEXT PRIMARY KEY, identity TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_reader_releases (scope TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_directories (directory TEXT PRIMARY KEY, owner_json TEXT);
      CREATE TABLE IF NOT EXISTS snapshot_comparison_retries (directory TEXT PRIMARY KEY REFERENCES snapshot_directories(directory) ON DELETE CASCADE, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_pending_diffs (directory TEXT PRIMARY KEY REFERENCES snapshot_directories(directory) ON DELETE CASCADE, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ephemeral_cleanup_records (token TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ephemeral_cleanup_owners (owner_key TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queued_inputs (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_queued_inputs (owner_key TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fork_preparations (directory TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS deletion_records (directory TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE IF NOT EXISTS fork_transactions (directory TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE IF NOT EXISTS fork_preparation_checkpoints (preparation TEXT NOT NULL, session_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(preparation, session_id));
      CREATE TABLE IF NOT EXISTS session_comparison_state (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_completed_comparisons (session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, turn_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(session_id, turn_id));`);

    if (columns.some(column => column.name === 'session_path')) {
      db.exec(`INSERT INTO session_repositories SELECT session_id, cwd, repository_root, remote_name, remote_url,
        branch, upstream_branch, head_commit, checked_at, observed_at, directory_exists FROM session_repositories_previous;
        DROP TABLE session_repositories_previous;`);
    }

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function repositoryQuery(db, columns, suffix = '') {
  const legacy = db.prepare('PRAGMA table_info(session_repositories)').all().some(column => column.name === 'session_path');
  const fields = columns.map(column => `${column === 'session_path' && !legacy ? 's' : 'r'}.${column}`).join(', ');

  return `SELECT ${fields} FROM session_repositories r${legacy ? '' : ' JOIN sessions s USING(session_id)'}${suffix}`;
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

function importDirectory(db, directory) {
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  for (const entry of entries) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) importDirectory(db, file);

    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    importTranscript(db, file);
  }
}

function importTranscript(db, file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let header;

  try {
    const buffer = Buffer.alloc(65536);
    const count = fs.readSync(descriptor, buffer);
    header = JSON.parse(buffer.subarray(0, count).toString().split('\n')[0]);
  } finally { fs.closeSync(descriptor); }

  if (header.type !== 'session') return;
  require('node:assert/strict').match(header.id, /\S/);
  register(db, header.id, file);
}

function importSessions(db, root) {
  db.exec('CREATE TABLE IF NOT EXISTS storage_migrations (name TEXT PRIMARY KEY); BEGIN IMMEDIATE');

  try {
    if (!db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('session-catalog-v1')) {
      for (const area of ['sessions', 'archived']) importDirectory(db, require('node:path').join(root, area));
      db.prepare('INSERT INTO storage_migrations VALUES (?)').run('session-catalog-v1');
    }

    importPublications(db, root);
    importRestorations(db, root);
    importRestorations(db, root, true);
    importRetention(db, root);
    importCleanupRequests(db, root);
    importWorktrees(db, root);
    importDirectories(db, root, 'fork-preparations', 'fork_preparations', 'fork-preparations-v1');
    importDirectories(db, root, 'fork-transactions', 'fork_transactions', 'fork-transactions-v1');
    importDirectories(db, root, 'delete-transactions', 'deletion_records', 'deletion-records-pending-v1');
    importDirectories(db, root, 'deleted-sessions', 'deletion_records', 'deletion-records-committed-v1');
    importRecoveryDirectories(db, root);
    importReaderReleases(db, root);
    importSnapshotDirectories(db, root);
    importComparisonRetries(db);
    importPendingDiffs(db);
    importJsonRecords(db, root, 'ephemeral-cleanup/owners', 'ephemeral_cleanup_owners', 'ephemeral-cleanup-owners-v1');
    importJsonRecords(db, root, 'queued-input', 'queued_inputs', 'queued-inputs-v1');
    importJsonRecords(db, root, 'conversation-queues', 'legacy_queued_inputs', 'legacy-queued-inputs-v1');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function importDirectories(db, root, area, table, migration) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(migration)) return;
  const directory = path.join(root, area);
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error(`Invalid ${area} storage`);
    db.prepare(`INSERT INTO ${table} (directory) VALUES (?)`).run(path.join(directory, entry.name));
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(migration);
}

function importJsonRecords(db, root, area, table, migration) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(migration)) return;
  const directory = path.join(root, area);
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    if (table === 'queued_inputs' && db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(entry.name.slice(0, -5))) continue;
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`)
      .run(entry.name.slice(0, -5), fs.readFileSync(path.join(directory, entry.name), 'utf8'));
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(migration);
}

function rows(root, sql) {
  const db = open(root);

  try { return db.prepare(sql).all(); }
  finally { db.close(); }
}

function queuedInputs(root) { return rows(root, 'SELECT session_id, record_json FROM queued_inputs UNION ALL SELECT owner_key AS session_id, record_json FROM legacy_queued_inputs'); }

function queuedInput(root, id) {
  const db = open(root);

  try {
    const key = require('node:crypto').createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 40);
    const row = db.prepare('SELECT record_json FROM queued_inputs WHERE session_id=lower(?) UNION ALL SELECT record_json FROM legacy_queued_inputs WHERE owner_key=? LIMIT 1').get(id, key);

    return row ? JSON.parse(row.record_json) : undefined;
  } finally { db.close(); }
}

function ephemeralOwners(root) { return rows(root, 'SELECT owner_key, record_json FROM ephemeral_cleanup_owners ORDER BY owner_key'); }

function importPendingDiffs(db) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('snapshot-pending-diffs-v1')) return;

  for (const row of db.prepare('SELECT directory FROM snapshot_directories').all()) {
    let body;

    try { body = fs.readFileSync(path.join(row.directory, 'pending-diff.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    db.prepare('INSERT INTO snapshot_pending_diffs VALUES (?, ?)').run(row.directory, body);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('snapshot-pending-diffs-v1');
}

function pendingDiffs(root) {
  const db = open(root);

  try { return db.prepare('SELECT directory, record_json FROM snapshot_pending_diffs').all(); }
  finally { db.close(); }
}

function pendingDiff(directory) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    const row = db.prepare('SELECT record_json FROM snapshot_pending_diffs WHERE directory=?').get(directory);

    return row ? JSON.parse(row.record_json) : undefined;
  } finally { db.close(); }
}

function savePendingDiff(directory, record) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    db.prepare('INSERT INTO snapshot_pending_diffs VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET record_json=excluded.record_json')
      .run(directory, JSON.stringify(record));
  } finally { db.close(); }
}

function importComparisonRetries(db) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('snapshot-comparison-retries-v1')) return;

  for (const row of db.prepare('SELECT directory FROM snapshot_directories').all()) {
    let body;

    try { body = fs.readFileSync(path.join(row.directory, 'comparison-retry.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    db.prepare('INSERT INTO snapshot_comparison_retries VALUES (?, ?)').run(row.directory, body);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('snapshot-comparison-retries-v1');
}

function comparisonRetry(directory) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    const row = db.prepare('SELECT record_json FROM snapshot_comparison_retries WHERE directory=?').get(directory);

    if (!row) return undefined;
    const record = JSON.parse(row.record_json);

    if (!record || record.version !== 1 || !['sessionId', 'turnId', 'messageId', 'baseline', 'current'].every(key => String(record[key]) === record[key])) throw new Error('Invalid comparison retry record');

    return record;
  } finally { db.close(); }
}

function saveComparisonRetry(directory, record) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    db.prepare('INSERT INTO snapshot_comparison_retries VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET record_json=excluded.record_json')
      .run(directory, JSON.stringify(record));
  } finally { db.close(); }
}

function removeComparisonRetry(directory) {
  const db = open(path.dirname(path.dirname(directory)));

  try { db.prepare('DELETE FROM snapshot_comparison_retries WHERE directory=?').run(directory); }
  finally { db.close(); }
}

function importCompletedComparisons(db, sessionId, retained) {
  if (db.prepare('SELECT 1 FROM session_comparison_state WHERE session_id=?').get(sessionId)) return;
  let completed = {};

  try { completed = JSON.parse(fs.readFileSync(require('node:path').join(retained, 'completed.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  if (!completed || Object.getPrototypeOf(completed) !== Object.prototype) throw new Error('Invalid completed comparison records');
  register(db, sessionId, retained.replace(/\.snapshots$/, '.jsonl'));

  for (const [turnId, messageId] of Object.entries(completed)) {
    if (String(messageId) !== messageId) throw new Error('Invalid completed comparison message');
    db.prepare('INSERT INTO session_completed_comparisons VALUES (?, ?, ?)').run(sessionId, turnId, messageId);
  }

  db.prepare('INSERT INTO session_comparison_state VALUES (?)').run(sessionId);
}

function completedComparisons(root, sessionId, retained, completed) {
  const db = open(root);
  db.exec('BEGIN IMMEDIATE');

  try {
    importCompletedComparisons(db, sessionId, retained);

    if (completed) {
      db.prepare('INSERT INTO session_completed_comparisons VALUES (?, ?, ?) ON CONFLICT(session_id, turn_id) DO UPDATE SET message_id=excluded.message_id')
        .run(sessionId, completed.turnId, completed.messageId);
    }

    const rows = db.prepare('SELECT turn_id, message_id FROM session_completed_comparisons WHERE session_id=?').all(sessionId);
    db.exec('COMMIT');

    return Object.fromEntries(rows.map(row => [row.turn_id, row.message_id]));
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function importSnapshotDirectories(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('snapshot-directories-v1')) return;
  const parent = path.join(root, 'git-snapshots');
  let entries;

  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(\.cleanup-)?pi-desktop-diff-/.test(entry.name)) continue;
    const directory = path.join(parent, entry.name);
    let owner = null;

    try { owner = fs.readFileSync(path.join(directory, 'temporary-owner.json'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    db.prepare('INSERT INTO snapshot_directories VALUES (?, ?)').run(directory, owner);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('snapshot-directories-v1');
}

function saveSnapshotOwner(directory, owner) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    db.prepare('INSERT INTO snapshot_directories VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET owner_json=excluded.owner_json')
      .run(directory, JSON.stringify(owner));
  } finally { db.close(); }
}

function snapshotDirectories(root) { return rows(root, 'SELECT directory, owner_json FROM snapshot_directories'); }

function snapshotOwner(directory) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    const row = db.prepare('SELECT owner_json FROM snapshot_directories WHERE directory=?').get(directory);

    return row?.owner_json ? JSON.parse(row.owner_json) : undefined;
  } finally { db.close(); }
}

function removeSnapshotDirectory(directory) {
  const db = open(path.dirname(path.dirname(directory)));

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM snapshot_directories WHERE directory=?').run(directory);
    db.prepare('DELETE FROM snapshot_recovery WHERE directory=?').run(directory);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function importReaderReleases(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('snapshot-reader-releases-v1')) return;
  const directory = path.join(root, 'git-snapshots', '.released-readers');
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
    const body = fs.readFileSync(path.join(directory, entry.name), 'utf8');
    JSON.parse(body);
    db.prepare('INSERT INTO snapshot_reader_releases VALUES (?, ?)').run(entry.name.slice(0, -5), body);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('snapshot-reader-releases-v1');
}

function releaseSnapshotReader(root, scope, record) {
  const db = open(root);

  try {
    db.prepare('INSERT INTO snapshot_reader_releases VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET record_json=excluded.record_json')
      .run(scope, JSON.stringify(record));
  } finally { db.close(); }
}

function snapshotReaderReleases(root) { return rows(root, 'SELECT scope, record_json FROM snapshot_reader_releases'); }

function removeSnapshotReaderRelease(root, row) {
  const db = open(root);

  try { db.prepare('DELETE FROM snapshot_reader_releases WHERE scope=? AND record_json=?').run(row.scope, row.record_json); }
  finally { db.close(); }
}

function importRecoveryDirectories(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('recovery-directories-v1')) return;
  const directory = path.join(root, 'recovery');
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, 'ownership.json');
    let body;

    try { body = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    JSON.parse(body);
    db.prepare('INSERT INTO recovery_directories VALUES (?, ?)').run(entry.name, body);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('recovery-directories-v1');
}

function recoveryRecords(root) { return rows(root, 'SELECT record_id, record_json FROM recovery_directories ORDER BY record_id'); }

function saveRecoveryRecord(root, record) {
  const db = open(root);

  try {
    db.prepare('INSERT INTO recovery_directories VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json')
      .run(record.id, JSON.stringify(record));
  } finally { db.close(); }
}

function importWorktrees(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('worktree-allocations-v1')) return;
  const directory = path.join(root, 'worktrees');
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{4}$/.test(entry.name)) continue;
    const container = path.join(directory, entry.name);
    const info = fs.lstatSync(container, { bigint: true });
    let parent = {};

    try { parent = JSON.parse(fs.readFileSync(path.join(container, 'parent.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    const value = { ...parent, containerIdentity: `${info.dev}:${info.ino}` };
    db.prepare('INSERT INTO worktree_allocations VALUES (?, ?)').run(container, JSON.stringify(value));
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('worktree-allocations-v1');
}

function recordWorktree(container, target, branch, parentBranch) {
  const db = open(path.dirname(path.dirname(container)));

  try {
    const info = fs.lstatSync(container, { bigint: true });

    if (!info.isDirectory()) throw new Error('Worktree allocation must be a directory');
    const identity = `${info.dev}:${info.ino}`;
    const value = { branch, parentBranch, containerIdentity: identity, allocation: { version: 1, identity, target } };
    db.prepare('INSERT INTO worktree_allocations VALUES (?, ?) ON CONFLICT(container) DO UPDATE SET metadata_json=excluded.metadata_json')
      .run(container, JSON.stringify(value));
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

function importCleanupRequests(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('cleanup-requests-v1')) return;

  for (const kind of ['goal', 'worktree']) {
    let metadata;

    try { metadata = fs.lstatSync(path.join(root, `${kind}-retention.pending`)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    if (!metadata.isFile()) throw new Error('Invalid cleanup request');
    db.prepare('INSERT OR IGNORE INTO cleanup_requests VALUES (?, 1)').run(kind);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('cleanup-requests-v1');
}

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

function importRetention(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('retention-candidates-v1')) return;
  const directory = path.join(root, 'retention-candidates');
  let names;

  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }

  for (const name of names.filter(name => name.endsWith('.json'))) {
    const descriptor = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    try {
      const metadata = fs.fstatSync(descriptor);

      if (!metadata.isFile()) throw new Error('Invalid deferred cleanup record');
      db.prepare('INSERT INTO retention_candidates VALUES (?, ?, ?)').run(name.slice(0, -5), fs.readFileSync(descriptor, 'utf8'), metadata.mtimeMs);
    } finally { fs.closeSync(descriptor); }
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('retention-candidates-v1');
}

function importRestorations(db, root, receipts = false) {
  const configuration = receipts
    ? { migration: 'session-restore-receipts-v1', table: 'session_restore_receipts', directory: 'restore-receipts', name: /^[a-f0-9]{64}\.json$/ }
    : { migration: 'session-restorations-v1', table: 'session_restorations', directory: 'restore-transactions', name: /^[a-f0-9]{40}\.json$/ };

  const { migration, table } = configuration;

  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(migration)) return;
  const directory = path.join(root, configuration.directory);
  let names;

  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }

  for (const name of names.filter(name => name.endsWith('.json'))) {
    if (!configuration.name.test(name)) throw new Error('Invalid restore record name');
    const descriptor = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid restore record');
      db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(name.slice(0, -5), fs.readFileSync(descriptor, 'utf8'));
    } finally { fs.closeSync(descriptor); }
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(migration);
}

function importPublications(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('session-publications-v1')) return;
  const directory = path.join(root, 'session-publications');
  let names;

  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }

  for (const name of names.filter(name => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(name))) {
    const file = path.join(directory, name);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let body;

    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid session publication record');
      body = fs.readFileSync(descriptor, 'utf8');
    } finally { fs.closeSync(descriptor); }

    db.prepare('INSERT INTO session_publications VALUES (?, ?)').run(name.slice(0, -5), body);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('session-publications-v1');
}

function publication(root, id) {
  const db = open(root);

  try {
    const row = db.prepare('SELECT record_json FROM session_publications WHERE publication_id=?').get(id);

    return row ? JSON.parse(row.record_json) : undefined;
  } finally { db.close(); }
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

function publications(root) {
  const db = open(root);

  try { return db.prepare('SELECT publication_id FROM session_publications ORDER BY publication_id').all().map(row => row.publication_id); }
  finally { db.close(); }
}

function open(root) {
  const file = require('node:path').join(root, 'sessions.sqlite');
  const db = new (require('node:sqlite').DatabaseSync)(file);

  try {
    require('node:fs').chmodSync(file, 0o600);
    initialize(db);
    importSessions(db, root);

    return db;
  } catch (error) { db.close(); throw error; }
}

function lookup(root, sessionId) {
  const db = open(root);

  try {
    return db.prepare(`SELECT session_path FROM sessions WHERE session_id=?
      AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))`).get(sessionId, sessionId)?.session_path;
  } finally { db.close(); }
}

function paths(root) {
  const db = open(root);

  try {
    return db.prepare(`SELECT session_path FROM sessions WHERE session_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(sessions.session_id))`)
      .all().map(row => row.session_path);
  } finally { db.close(); }
}

function storageRoot(file) {
  let directory = path.dirname(file);

  while (path.dirname(directory) !== directory) {
    if (['sessions', 'archived'].includes(path.basename(directory))) return path.dirname(directory);
    directory = path.dirname(directory);
  }

  throw new Error('Conversation is outside session storage');
}

module.exports = { initialize, repositoryQuery, movePaths, register, registerPath, importSessions, open, lookup, paths, storageRoot,
  publication, savePublication, removePublication, publications, markCleanup, cleanupRequest, finishCleanup,
  recordWorktree, worktreeMetadata, worktreeContainers, recoveryRecords, saveRecoveryRecord, releaseSnapshotReader, snapshotReaderReleases, removeSnapshotReaderRelease, saveSnapshotOwner, snapshotDirectories, snapshotOwner, removeSnapshotDirectory, completedComparisons, comparisonRetry, saveComparisonRetry, removeComparisonRetry, pendingDiffs, pendingDiff, savePendingDiff, ephemeralOwners, queuedInputs, queuedInput };
