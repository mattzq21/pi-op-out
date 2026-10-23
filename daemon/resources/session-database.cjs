const fs = require('node:fs');
const path = require('node:path');

function initialize(db) {
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;`);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
      CREATE TABLE IF NOT EXISTS session_branch_selection (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, tip_id TEXT, leaf_id TEXT);
      CREATE TABLE IF NOT EXISTS session_extension_state (session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, state_key TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(session_id, state_key));
      CREATE TABLE IF NOT EXISTS session_extension_records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, entry_id TEXT NOT NULL, after_id TEXT, entry_json TEXT NOT NULL, UNIQUE(session_id, entry_id)); CREATE INDEX IF NOT EXISTS session_extension_records_order ON session_extension_records(session_id, sequence);
      CREATE TABLE IF NOT EXISTS session_goals (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, goal_id TEXT NOT NULL UNIQUE, objective TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'complete')));
      CREATE TABLE IF NOT EXISTS session_goal_ids (goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_file_metadata (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, session_path TEXT NOT NULL, modified_ns TEXT NOT NULL, size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_file_writes (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE); CREATE TRIGGER IF NOT EXISTS session_file_metadata_moved AFTER UPDATE ON sessions WHEN OLD.session_path IS NOT NEW.session_path BEGIN DELETE FROM session_file_metadata WHERE session_id=OLD.session_id; END;`);

    db.exec(`      CREATE TABLE IF NOT EXISTS session_sidebar (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_child_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        complete INTEGER NOT NULL CHECK(complete IN (0, 1)));
      CREATE TABLE IF NOT EXISTS session_children (
        parent_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('subagent', 'review')),
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
        host_id TEXT, host_name TEXT);
      CREATE TABLE IF NOT EXISTS session_group_assignments (session_key TEXT PRIMARY KEY, group_id TEXT);
      CREATE TABLE IF NOT EXISTS session_group_removed_projects (project_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_publications (publication_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_restore_receipts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_candidates (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, retry_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS retention_retry_order ON retention_candidates(retry_at, record_id);
      CREATE TABLE IF NOT EXISTS cleanup_requests (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_directories (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS goal_asset_dependencies (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity));
      CREATE TABLE IF NOT EXISTS goal_asset_reclamations (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_item_sequence (id INTEGER PRIMARY KEY CHECK(id=1), last_id INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_item_sequence VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS queue_origins (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        cwd TEXT NOT NULL, session_path TEXT);
      CREATE TABLE IF NOT EXISTS queue_items (
        queue_item_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        queue_position INTEGER NOT NULL CHECK(queue_position BETWEEN 1 AND 100),
        message TEXT NOT NULL, behavior TEXT NOT NULL CHECK(behavior IN ('steer', 'followUp')),
        details_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue_items_order ON queue_items(session_id, queue_position);
      CREATE TRIGGER IF NOT EXISTS queue_items_limit BEFORE INSERT ON queue_items
        WHEN NOT EXISTS(SELECT 1 FROM queue_items WHERE queue_item_id=NEW.queue_item_id)
          AND (SELECT count(*) FROM queue_items WHERE session_id=NEW.session_id)>=100
        BEGIN SELECT RAISE(ABORT, 'A session can have at most 100 queued items'); END;
      CREATE TABLE IF NOT EXISTS queue_attachments (
        attachment_id INTEGER PRIMARY KEY,
        queue_item_id INTEGER NOT NULL REFERENCES queue_items(queue_item_id) ON DELETE CASCADE,
        attachment_position INTEGER NOT NULL CHECK(attachment_position>=1),
        media_type TEXT NOT NULL, data BLOB NOT NULL, details_json TEXT NOT NULL,
        UNIQUE(queue_item_id, attachment_position));
      CREATE TABLE IF NOT EXISTS session_directories (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, cwd TEXT NOT NULL, checked_at INTEGER NOT NULL, directory_exists INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_transactions (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('archive', 'delete', 'restore')), state TEXT NOT NULL CHECK(state IN ('prepared', 'committed')), journal_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_worktrees (chat_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
`);

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function directoryQuery(_db, columns, suffix = '') {
  const fields = columns.map(column => `${column === 'session_path' ? 's' : 'r'}.${column}`).join(', ');

  return `SELECT ${fields} FROM session_directories r JOIN sessions s USING(session_id)${suffix}`;
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

function reserve(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = open(root);

  try { return reserveId(db); }
  finally { db.close(); }
}

function reserveId(db) {
  const insert = db.prepare("INSERT INTO sessions (session_id) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM storage_transactions s, json_each(s.journal_json, '$.targets') t WHERE json_extract(t.value, '$.sessionId')=?1) ON CONFLICT(session_id) DO NOTHING");

  for (;;) {
    const id = require('node:crypto').randomUUID();

    if (Number(insert.run(id).changes) === 1) return id;
  }
}

const pendingTables = {
  transaction: ['storage_transactions'],
  recovery: ['session_publications', 'session_restore_receipts', 'storage_transactions'],
  retention: ['retention_candidates', 'cleanup_requests', 'storage_transactions'],
};

function pending(db, work) {
  const tables = pendingTables[work];

  if (!tables) throw new Error(`Unknown pending storage work: ${work}`);

  return Boolean(db.prepare(`SELECT (${tables.map(table => `EXISTS(SELECT 1 FROM ${table})`).join(' OR ')}) AS pending`).get().pending);
}

function bind(db, sessionId, sessionPath) {
  const changed = db.prepare('UPDATE sessions SET session_path=? WHERE session_id=? AND (session_path IS NULL OR session_path=?)').run(sessionPath, sessionId, sessionPath);

  if (changed.changes !== 1) throw new Error('Session ID is not reserved or already belongs to another session');
}

function register(db, sessionId, sessionPath) {
  if (!db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path=?').get(sessionId, sessionPath)) throw new Error('Session path does not match its reserved ID');
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

function queueRecord(db, id) {
  const origin = db.prepare('SELECT cwd, session_path AS sessionPath FROM queue_origins WHERE session_id=?').get(id);

  if (!origin) return undefined;

  const items = db.prepare('SELECT * FROM queue_items WHERE session_id=? ORDER BY queue_position').all(id).map(row => {
    const item = { ...JSON.parse(row.details_json), id: String(row.queue_item_id), message: row.message, behavior: row.behavior };

    const images = db.prepare('SELECT * FROM queue_attachments WHERE queue_item_id=? ORDER BY attachment_position').all(row.queue_item_id)
      .map(image => ({ ...JSON.parse(image.details_json), mimeType: image.media_type, data: Buffer.from(image.data).toString('base64') }));

    if (images.length) item.images = images;

    return item;
  });

  return items.length ? { version: 1, origin, items } : undefined;
}

function queuedInputs(root) {
  const db = open(root);

  try {
    db.exec('BEGIN');

    return db.prepare('SELECT session_id FROM queue_origins').all().flatMap(row => {
      const record = queueRecord(db, row.session_id);

      return record ? [{ session_id: row.session_id, record_json: JSON.stringify(record) }] : [];
    });
  } finally { db.close(); }
}

function queuedInput(root, id) {
  const db = open(root);

  try { db.exec('BEGIN');

    return queueRecord(db, id.toLowerCase()); }
  finally { db.close(); }
}

function recoveryRecords(root) { return rows(root, 'SELECT record_id, record_json FROM recovery_directories ORDER BY record_id'); }

function saveRecoveryRecord(root, record, reserve = false) {
  const db = open(root);

  try {
    db.prepare('INSERT INTO recovery_directories VALUES (?, ?)' + (reserve ? '' : ' ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json'))
      .run(record.id, JSON.stringify(record));
  } finally { db.close(); }
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
    return db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId)?.session_path;
  } finally { db.close(); }
}

function paths(root, directory) {
  const prefix = directory === undefined ? null : path.resolve(directory) + path.sep;

  return rows(root, 'SELECT session_path FROM sessions WHERE session_path IS NOT NULL AND (? IS NULL OR substr(session_path, 1, length(?))=?)', prefix, prefix, prefix).map(row => row.session_path);
}

function storageRoot(file) {
  let directory = path.dirname(file);

  while (path.dirname(directory) !== directory) {
    if (['sessions', 'archived'].includes(path.basename(directory))) return path.dirname(directory);
    directory = path.dirname(directory);
  }

  throw new Error('Conversation is outside session storage');
}

module.exports = { initialize, reserve, reserveId, pending, bind, directoryQuery, movePaths, register, registerPath, open, lookup, paths, storageRoot, publication, savePublication, removePublication, publications, markCleanup, cleanupRequest, finishCleanup,
  recoveryRecords, saveRecoveryRecord, queuedInputs, queuedInput };
