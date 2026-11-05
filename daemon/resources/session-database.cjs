const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { onMainThread, holdTransaction } = require('./main-thread.cjs');

function rollback(db, error) {
  if (!db.isTransaction) return error;

  try { db.exec('ROLLBACK'); }
  catch (failure) {
    if (!(error instanceof Error)) return new AggregateError([error, failure], `Transaction failed; rollback also failed: ${failure.message}`);
    error.message += `; rollback also failed: ${failure.message}`;
    error.rollbackError = failure;
  }

  return error;
}

const SCHEMA_VERSION = 6;

// The whole storage schema. Only this module creates or changes tables.
const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
      CREATE TABLE IF NOT EXISTS session_branch_selection (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, tip_id TEXT, leaf_id TEXT);
      CREATE TABLE IF NOT EXISTS session_extension_state (session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, state_key TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(session_id, state_key));
      CREATE TABLE IF NOT EXISTS session_extension_records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, entry_id TEXT NOT NULL, after_id TEXT, entry_json TEXT NOT NULL, UNIQUE(session_id, entry_id)); CREATE INDEX IF NOT EXISTS session_extension_records_order ON session_extension_records(session_id, sequence);
      CREATE TABLE IF NOT EXISTS session_goals (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, goal_id TEXT NOT NULL UNIQUE, objective TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'complete')), submission_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS session_goal_ids (goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_file_metadata (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, session_path TEXT NOT NULL, modified_ns TEXT NOT NULL, size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_file_writes (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_sidebar (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auxiliary_child_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        complete INTEGER NOT NULL CHECK(complete IN (0, 1)));
      CREATE TABLE IF NOT EXISTS auxiliary_children (
        parent_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(length(kind) > 0),
        PRIMARY KEY(parent_id, child_id));
      CREATE INDEX IF NOT EXISTS auxiliary_children_child ON auxiliary_children(child_id);
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
      CREATE TABLE IF NOT EXISTS session_group_orders (scope TEXT NOT NULL, owner TEXT NOT NULL, position INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY(scope, owner, position));
      CREATE TABLE IF NOT EXISTS session_publications (publication_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_requests (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_directories (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS session_queue_holds (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
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
      CREATE TABLE IF NOT EXISTS chat_worktrees (chat_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_outcomes (submission_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('received', 'accepted', 'rejected')), error TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_names (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS running_tasks (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS storage_transcript_summaries (session_path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body BLOB NOT NULL);
      CREATE TRIGGER IF NOT EXISTS storage_transcript_summaries_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM storage_transcript_summaries WHERE session_path=OLD.session_path;
      END;
      CREATE TABLE IF NOT EXISTS transcript_references (session_path TEXT PRIMARY KEY, session_id TEXT, fingerprint TEXT NOT NULL, entries_json TEXT NOT NULL, format_version INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS transcript_references_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM transcript_references WHERE session_path=OLD.session_path AND session_id=lower(OLD.session_id);
      END;
      CREATE TABLE IF NOT EXISTS session_mailbox_receipt_cache (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        session_path TEXT NOT NULL, fingerprint TEXT NOT NULL, deliveries_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sdk_settings (path TEXT PRIMARY KEY, body TEXT);
      CREATE TABLE IF NOT EXISTS sdk_session_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        session_path TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_group_parents (group_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL);
      INSERT OR IGNORE INTO session_group_state VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS project_repositories (cwd TEXT PRIMARY KEY, repository TEXT);
      CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB);
      CREATE TABLE IF NOT EXISTS agent_prompt_snapshots (digest TEXT PRIMARY KEY, contents TEXT);
      CREATE TABLE IF NOT EXISTS project_agent_definitions (directory TEXT PRIMARY KEY, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_inventory (id INTEGER PRIMARY KEY CHECK (id = 1), entries_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_inventory (id INTEGER PRIMARY KEY CHECK (id = 1), entries_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_inventory (root TEXT PRIMARY KEY, entries_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restart_records (name TEXT PRIMARY KEY CHECK(name IN ('plan', 'status')), record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restart_backups (id TEXT PRIMARY KEY, digest TEXT);
`;

function initialize(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');

  try {
    if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) db.exec(SCHEMA + `PRAGMA user_version=${SCHEMA_VERSION};`);
    db.exec('COMMIT');
  } catch (error) { throw rollback(db, error); }
}

const connections = new Map();

// Only the daemon that holds the daemon lock changes the storage. Every other process opens the database read-only, so
// a write that skips the one writer fails at once: each Pi and the provider SDK (they have a storage channel), the
// daemon's worker threads (they ask its main thread), and the helper processes of piopd that called readOnlyStorage.
const READER = Symbol.for('piop.storage-reader');

function readOnlyStorage() { Object.defineProperty(globalThis, READER, { value: true }); }

function readOnlyProcess() { return Object.hasOwn(globalThis, READER) || require('./storage-channel.cjs').hasChannel() || require('./main-thread.cjs').linkedWorker(); }

function open(directory, file, current) {
  if (!readOnlyProcess()) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      initialize(db);
    } catch (error) { db.close(); throw error; }
    return db;
  }
  if (!current && require('./main-thread.cjs').linkedWorker()) createDatabase(directory);
  else if (!current) throw new Error('The Piop daemon has not made the storage database in ' + directory);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    // A reader may be a newer piopd that checks a restart before it takes over; its tables are those of the running daemon.
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version < 1 || version > SCHEMA_VERSION) throw new Error('The storage database does not have the format of this Piop version');
  } catch (error) { db.close(); throw error; }
  return db;
}

// A worker that opens a storage database before the main thread did asks the main thread to make it.
const createDatabase = onMainThread('session-database.create', root => { connection(root); });

// The one connection of this process to the storage database of root. Do not close it.
// A database file that was replaced or removed gets a new connection, so no write goes to a deleted file.
function connection(root) {
  const directory = path.resolve(root);
  const file = path.join(directory, 'sessions.sqlite');
  const cached = connections.get(file);
  const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });

  if (cached && current && current.dev === cached.dev && current.ino === cached.ino) return cached.db;

  if (cached) { connections.delete(file); cached.db.close(); }

  if (current?.isSymbolicLink()) throw new Error('Database path must not be a symbolic link');
  const db = open(directory, file, current);

  try {
    const opened = fs.lstatSync(file, { bigint: true });
    connections.set(file, { db, dev: opened.dev, ino: opened.ino });
  } catch (error) { db.close(); throw error; }

  return db;
}

let savepoints = 0;

// Runs operation as one atomic change. Inside another transaction of the same connection it becomes a savepoint.
function transaction(db, behavior, operation) {
  if (db.isTransaction) return savepoint(db, operation);
  db.exec(`BEGIN ${behavior}`);
  const release = holdTransaction();

  try {
    const result = operation();

    if (typeof result?.then === 'function') throw new Error('A database transaction must not wait for other work');
    db.exec('COMMIT');

    return result;
  } catch (error) { throw rollback(db, error); }
  finally { release(); }
}

function savepoint(db, operation) {
  const name = `nested_${++savepoints}`;
  db.exec(`SAVEPOINT ${name}`);

  try {
    const result = operation();

    if (typeof result?.then === 'function') throw new Error('A database transaction must not wait for other work');
    db.exec(`RELEASE ${name}`);

    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); }
      catch (failure) { throw rollback(db, error); }
    }

    throw error;
  }
}

function directoryQuery(_db, columns, suffix = '') {
  const fields = columns.map(column => `${column === 'session_path' ? 's' : 'r'}.${column}`).join(', ');

  return `SELECT ${fields} FROM session_directories r JOIN sessions s USING(session_id)${suffix}`;
}

const reserve = onMainThread('session-database.reserve', (root) => {
  return reserveId(connection(root));
});

function reserveId(db) {
  const insert = db.prepare('INSERT INTO sessions (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING');

  for (;;) {
    const id = require('node:crypto').randomUUID();

    if (Number(insert.run(id).changes) === 1) return id;
  }
}

const pendingTables = {
  recovery: ['session_publications'],
  retention: ['cleanup_requests'],
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
  register(connection(root), sessionId, sessionPath);
}

function rows(root, sql, ...parameters) {
  return connection(root).prepare(sql).all(...parameters);
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
  const db = connection(root);

  return transaction(db, 'DEFERRED', () => db.prepare('SELECT session_id FROM queue_origins').all().flatMap(row => {
    const record = queueRecord(db, row.session_id);

    return record ? [{ session_id: row.session_id, record_json: JSON.stringify(record) }] : [];
  }));
}

function queuedInput(root, id) {
  const db = connection(root);

  return transaction(db, 'DEFERRED', () => queueRecord(db, id.toLowerCase()));
}

function recoveryRecords(root) { return rows(root, 'SELECT record_id, record_json FROM recovery_directories ORDER BY record_id'); }

const saveRecoveryRecord = onMainThread('session-database.saveRecoveryRecord', (root, record, reserve = false) => {
  connection(root).prepare('INSERT INTO recovery_directories VALUES (?, ?)' + (reserve ? '' : ' ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json'))
    .run(record.id, JSON.stringify(record));
});

function cleanupRequest(root, kind) {
  return connection(root).prepare('SELECT revision FROM cleanup_requests WHERE kind=?').get(kind)?.revision;
}

const finishCleanup = onMainThread('session-database.finishCleanup', (root, kind, revision) => {
  connection(root).prepare('DELETE FROM cleanup_requests WHERE kind=? AND revision=?').run(kind, revision);
});

function publication(root, id) {
  const row = rows(root, 'SELECT record_json FROM session_publications WHERE publication_id=?', id)[0];

  return row ? JSON.parse(row.record_json) : undefined;
}

const savePublication = onMainThread('session-database.savePublication', (root, id, record) => {
  connection(root).prepare(`INSERT INTO session_publications VALUES (?, ?) ON CONFLICT(publication_id) DO UPDATE SET record_json=excluded.record_json`)
    .run(id, JSON.stringify(record));
});

const removePublication = onMainThread('session-database.removePublication', (root, id) => {
  connection(root).prepare('DELETE FROM session_publications WHERE publication_id=?').run(id);
});

function publications(root) { return rows(root, 'SELECT publication_id FROM session_publications ORDER BY publication_id').map(row => row.publication_id); }

function lookup(root, sessionId) {
  return connection(root).prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId)?.session_path;
}

function paths(root, directory) {
  const prefix = directory === undefined ? null : path.resolve(directory) + path.sep;

  return rows(root, 'SELECT session_path FROM sessions WHERE session_path IS NOT NULL AND (? IS NULL OR substr(session_path, 1, length(?))=?)', prefix, prefix, prefix).map(row => row.session_path);
}

function storageRoot(file) {
  let directory = path.dirname(file);

  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'sessions') return path.dirname(directory);
    directory = path.dirname(directory);
  }

  throw new Error('Conversation is outside session storage');
}

module.exports = { readOnlyStorage, rollback, transaction, connection, reserve, reserveId, pending, bind, directoryQuery, register, registerPath, lookup, paths, storageRoot, publication, savePublication, removePublication, publications, cleanupRequest, finishCleanup,
  recoveryRecords, saveRecoveryRecord, queuedInputs, queuedInput };
