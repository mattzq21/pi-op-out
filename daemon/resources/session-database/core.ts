import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { onMainThread, holdTransaction } from './main-thread.ts';
import * as StorageChannel from './storage-channel.ts';
import * as MainThread from './main-thread.ts';
import Crypto from 'node:crypto';

// The shared connection of this process. Never close it. Only the modules in session-database/ and tests use it.
export type Connection = Omit<DatabaseSync, "close">;


// The core of the storage database: its file, schema, connection and transactions. Only the modules in this folder use
// it; all other code uses the named operations of index.ts.

const DATABASE_NAME = 'sessions.sqlite';

function databaseFile(root: string): string { return path.join(path.resolve(root), DATABASE_NAME); }

// True when a file named name in a storage folder is part of the storage database (the file or its WAL files).
function isDatabaseChange(name: string): boolean { return name.startsWith(DATABASE_NAME); }

// True when the storage database of root exists, false when it does not. Throws when it is not a regular file.
function databaseExists(root: string): boolean {
  const file = databaseFile(root);
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!metadata) return false;
  if (!metadata.isFile()) throw new Error(`Storage database is not a regular file: ${file}`);
  return true;
}

function rollback(db: Connection, error: unknown): unknown {
  if (!db.isTransaction) return error;

  try { db.exec('ROLLBACK'); }
  catch (failure) {
    if (!(error instanceof Error)) return new AggregateError([error, failure], `Transaction failed; rollback also failed: ${failure.message}`);
    error.message += `; rollback also failed: ${failure.message}`;
    (error as Error & { rollbackError?: unknown }).rollbackError = failure;
  }

  return error;
}

const SCHEMA_VERSION = 10;

// The whole storage schema. Only this module creates or changes tables.
const SCHEMA = `DROP TABLE IF EXISTS queue_origins; DROP TABLE IF EXISTS recovery_directories; DROP TABLE IF EXISTS cleanup_requests; DROP TABLE IF EXISTS session_directories; DROP TABLE IF EXISTS session_mailbox; DROP TABLE IF EXISTS session_mailbox_receipts;
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)), revision INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
      CREATE TABLE IF NOT EXISTS session_branch_selection (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, tip_id TEXT, leaf_id TEXT);
      CREATE TABLE IF NOT EXISTS session_extension_state (session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, state_key TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(session_id, state_key));
      CREATE TABLE IF NOT EXISTS session_extension_records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, entry_id TEXT NOT NULL, after_id TEXT, entry_json TEXT NOT NULL, UNIQUE(session_id, entry_id)); CREATE INDEX IF NOT EXISTS session_extension_records_order ON session_extension_records(session_id, sequence);
      CREATE TABLE IF NOT EXISTS session_goals (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, goal_id TEXT NOT NULL UNIQUE, objective TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'complete')), submission_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS session_goal_ids (goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_sidebar (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auxiliary_children (
        parent_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(length(kind) > 0),
        PRIMARY KEY(parent_id, child_id));
      CREATE INDEX IF NOT EXISTS auxiliary_children_child ON auxiliary_children(child_id);
      CREATE TABLE IF NOT EXISTS session_mailbox (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        message_json TEXT NOT NULL, PRIMARY KEY(session_id, delivery_id));
      CREATE INDEX IF NOT EXISTS session_mailbox_order ON session_mailbox(session_id, sequence);
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
      CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_item_sequence (id INTEGER PRIMARY KEY CHECK(id=1), last_id INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_item_sequence VALUES (1, 0);
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
      CREATE TABLE IF NOT EXISTS chat_worktrees (chat_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_outcomes (submission_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('received', 'accepted', 'rejected')), error TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_names (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS running_tasks (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS session_mailbox_receipts (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL, PRIMARY KEY(session_id, delivery_id));
      CREATE TABLE IF NOT EXISTS sdk_settings (path TEXT PRIMARY KEY, body TEXT);
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

function initialize(db: DatabaseSync): void {
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');

  try {
    if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < SCHEMA_VERSION) db.exec(SCHEMA + `PRAGMA user_version=${SCHEMA_VERSION};`);
    db.exec('COMMIT');
  } catch (error) { throw rollback(db, error); }
}

const connections = new Map<string, DatabaseSync>();

// Only the daemon that holds the daemon lock changes the storage. Every other process opens the database read-only, so
// a write that skips the one writer fails at once: each Pi and the provider SDK (they have a storage channel), the
// daemon's worker threads (they ask its main thread), and the helper processes of piopd that called readOnlyStorage.
const READER = Symbol.for('piop.storage-reader');

function readOnlyStorage(): void { Object.defineProperty(globalThis, READER, { value: true }); }

function readOnlyProcess(): boolean { return Object.hasOwn(globalThis, READER) || StorageChannel.hasChannel() || MainThread.linkedWorker(); }

function open(directory: string, file: string, current: fs.Stats | undefined): DatabaseSync {
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
  if (!current && MainThread.linkedWorker()) createDatabase(directory);
  else if (!current) throw new Error('The Piop daemon has not made the storage database in ' + directory);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    // A reader may be a newer piopd that checks a restart before it takes over; its tables are those of the running daemon.
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version < 1 || version > SCHEMA_VERSION) throw new Error('The storage database does not have the format of this Piop version');
  } catch (error) { db.close(); throw error; }
  return db;
}

// A worker that opens a storage database before the main thread did asks the main thread to make it.
const createDatabase = onMainThread('session-database.create', (root: string) => { connection(root); });

// The one connection of this process to the storage database of root. Do not close it.
function connection(root: string): Connection {
  const directory = path.resolve(root);
  const file = databaseFile(directory);
  const cached = connections.get(file);

  if (cached) return cached;
  const current = fs.lstatSync(file, { throwIfNoEntry: false });

  if (current?.isSymbolicLink()) throw new Error('Database path must not be a symbolic link');
  const db = open(directory, file, current);
  connections.set(file, db);

  return db;
}

let savepoints = 0;

// Runs operation as one atomic change on the storage database of root. Inside another transaction it becomes a savepoint.
function transaction<T>(root: string, behavior: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE", operation: () => T): T { return transactionOf(connection(root), behavior, operation); }

function transactionOf<T>(db: Connection, behavior: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE", operation: () => T): T {
  if (db.isTransaction) return savepoint(db, operation);
  db.exec(`BEGIN ${behavior}`);
  const release = holdTransaction();

  try {
    const result = operation();

    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') throw new Error('A database transaction must not wait for other work');
    db.exec('COMMIT');

    return result;
  } catch (error) { throw rollback(db, error); }
  finally { release(); }
}

function savepoint<T>(db: Connection, operation: () => T): T {
  const name = `nested_${++savepoints}`;
  db.exec(`SAVEPOINT ${name}`);

  try {
    const result = operation();

    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') throw new Error('A database transaction must not wait for other work');
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

const reserve = onMainThread('session-database.reserve', (root: string) => reserveId(root));

// Reserves a new session ID in the storage database of root.
function reserveId(root: string): string {
  const insert = connection(root).prepare('INSERT INTO sessions (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING');

  for (;;) {
    const id = Crypto.randomUUID();

    if (Number(insert.run(id).changes) === 1) return id;
  }
}

// Gives the reserved session ID its transcript path.
function bind(root: string, sessionId: string, sessionPath: string): void {
  const changed = connection(root).prepare('UPDATE sessions SET session_path=? WHERE session_id=? AND (session_path IS NULL OR session_path=?)').run(sessionPath, sessionId, sessionPath);

  if (changed.changes !== 1) throw new Error('Session ID is not reserved or already belongs to another session');
}

// Throws when sessionId is not registered with sessionPath.
function register(root: string, sessionId: string, sessionPath: string): void {
  if (!isRegistered(root, sessionId, sessionPath)) throw new Error('Session path does not match its reserved ID');
}

// True when sessionId is registered with sessionPath.
function isRegistered(root: string, sessionId: string, sessionPath: string): boolean {
  return Boolean(connection(root).prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path=?').get(sessionId, sessionPath));
}

// Marks a change of what the chat sessionId shows: its transcript, records, name or branch. Caches of it keep the
// revision they were made from.
function touch(db: Connection, sessionId: string): void {
  db.prepare('UPDATE sessions SET revision=revision+1 WHERE session_id=?').run(sessionId);
}

// touch, from any thread, before a change of the transcript of sessionId.
const revise = onMainThread('session-database.revise', (root: string, sessionId: string) => touch(connection(root), sessionId));

// touch, from any thread, before a change of the transcript at file.
const revisePath = onMainThread('session-database.revisePath', (root: string, file: string) => {
  connection(root).prepare('UPDATE sessions SET revision=revision+1 WHERE session_path=?').run(file);
});

function rows<Row>(root: string, sql: string, ...parameters: SQLInputValue[]): Row[] {
  return connection(root).prepare(sql).all(...parameters) as Row[];
}

function lookup(root: string, sessionId: string): string | null | undefined {
  return (connection(root).prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId) as { session_path: string | null } | undefined)?.session_path;
}

function paths(root: string, directory?: string): string[] {
  const prefix = directory === undefined ? null : path.resolve(directory) + path.sep;

  return rows<{ session_path: string }>(root, 'SELECT session_path FROM sessions WHERE session_path IS NOT NULL AND (? IS NULL OR substr(session_path, 1, length(?))=?)', prefix, prefix, prefix).map(row => row.session_path);
}

function storageRoot(file: string): string {
  let directory = path.dirname(file);

  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'sessions') return path.dirname(directory);
    directory = path.dirname(directory);
  }

  throw new Error('Conversation is outside session storage');
}

export { connection, transactionOf, rows, isDatabaseChange, databaseExists, readOnlyStorage, transaction, reserve, reserveId, bind, register, isRegistered, lookup, paths, storageRoot, touch, revise, revisePath };
