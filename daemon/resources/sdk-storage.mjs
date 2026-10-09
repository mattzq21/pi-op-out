import { DatabaseSync as StorageDatabase } from "node:sqlite";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";
import { spawnSync as storageSpawn } from "node:child_process";
import { createHash as storageHash } from "node:crypto";

const installedStorageClasses = new WeakSet();

const failedSessionStorage = new WeakSet();

const sessionReferenceBaselines = new WeakMap();

function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

function registerExternalTranscript(root, transcript) {
  if (!transcript) return;
  const file = storagePath.resolve(transcript);
  const relative = storagePath.relative(root, file);

  if (["sessions", "archived", "fork-transactions", "fork-preparations"].some(area => relative.startsWith(area + storagePath.sep))) return;
  const databasePath = storagePath.join(root, "sessions.sqlite");
  storageFs.closeSync(storageFs.openSync(databasePath, "a", 0o600));
  const database = new StorageDatabase(databasePath);

  try {
    storageFs.chmodSync(databasePath, 0o600);
    database.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    database.prepare("INSERT INTO external_transcripts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json")
      .run(storageHash("sha256").update(file).digest("hex"), JSON.stringify({ path: file }));
  } finally { database.close(); }
}

function registerManagedTranscript(manager, saved = false) {
  if (!manager.persist || !manager.sessionFile) return;
  const root = sessionReferenceRoot();
  const file = storagePath.resolve(manager.sessionFile);
  const area = storagePath.relative(root, file).split(storagePath.sep)[0];

  if (!["sessions", "archived"].includes(area)) return;
  const header = manager.fileEntries[0];

  if (header?.type !== "session" || !header.id || header.id !== String(header.id)) throw new Error("Cannot register a session without its saved identity");
  const databasePath = storagePath.join(root, "sessions.sqlite");
  storageFs.closeSync(storageFs.openSync(databasePath, "a", 0o600));
  const database = new StorageDatabase(databasePath);

  try {
    storageFs.chmodSync(databasePath, 0o600);
    database.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT);
      CREATE TABLE IF NOT EXISTS session_deletion_tombstones (session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, session_path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_file_metadata (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, session_path TEXT NOT NULL, modified_ns TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_file_writes (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      BEGIN IMMEDIATE;`);
    registerManagedPath(database, header.id, file);
    saveManagedMetadata(database, header.id, file, saved);
    database.exec("COMMIT");
  } finally { database.close(); }
}

function saveManagedMetadata(database, id, file, saved) {
  database.prepare("DELETE FROM session_file_metadata WHERE session_id=?").run(id);

  if (!saved) {
    database.prepare("INSERT INTO session_file_writes VALUES (?) ON CONFLICT DO NOTHING").run(id);

    return;
  }

  const metadata = storageFs.lstatSync(file, { bigint: true });

  if (!metadata.isFile()) throw new Error("Saved session is not a regular file");
  database.prepare("INSERT INTO session_file_metadata VALUES (?, ?, ?, ?)").run(id, file, String(metadata.mtimeNs), metadata.size);
  database.prepare("DELETE FROM session_file_writes WHERE session_id=?").run(id);
}

function finishManagedTranscript(manager) {
  try { registerManagedTranscript(manager, true); }
  catch (error) { failedSessionStorage.add(manager); throw error; }
}

function registerManagedPath(database, sessionId, file) {
  if (database.prepare("SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)").get(sessionId)) throw new Error("Cannot save a deleted session");
  const previous = database.prepare("SELECT session_path FROM sessions WHERE session_id=?").get(sessionId);

  if (previous?.session_path && previous.session_path !== file && storageFs.existsSync(previous.session_path)) throw new Error("Session identity has more than one transcript");
  database.prepare("INSERT INTO sessions VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path").run(sessionId, file);
}

function textGoalReferences(text, root, found) {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}/(?:sessions|archived|fork-transactions|fork-preparations)/(?:[^\\r\\n]*?/)?attachments/goal-[A-Za-z0-9]{6}(?![A-Za-z0-9])`);
  const prefix = root + "/";
  let start = text.indexOf(prefix);

  while (start !== -1) {
    const next = text.indexOf(prefix, start + prefix.length);
    const segment = text.slice(start, next === -1 ? undefined : next);
    const match = pattern.exec(segment);

    if (match && storagePath.resolve(match[0]) === match[0]) found.add(match[0]);
    start = next;
  }
}

function managedGoalReferences(value, root = sessionReferenceRoot()) {
  const found = new Set();

  for (const token of JSON.stringify(value).matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    textGoalReferences(JSON.parse(token[0]), root, found);
  }

  return found;
}

function goalTextFiles(directory) {
  const info = storageFs.lstatSync(directory, { bigint: true });
  const identity = `${info.dev}:${info.ino}`;
  const file = storagePath.join(sessionReferenceRoot(), 'sessions.sqlite');
  const db = new StorageDatabase(file);

  try {
    storageFs.chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS goal_text_files (directory TEXT NOT NULL, identity TEXT NOT NULL, names_json TEXT NOT NULL, PRIMARY KEY(directory, identity));`);
    const query = db.prepare('SELECT names_json FROM goal_text_files WHERE directory=? AND identity=?');
    let row = query.get(directory, identity);

    if (!row) {
      const names = storageFs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(md|txt)$/.test(entry.name)).map(entry => entry.name);
      const after = storageFs.lstatSync(directory, { bigint: true });

      if (`${after.dev}:${after.ino}` !== identity) throw new Error('Goal text directory changed during import');
      db.prepare('INSERT INTO goal_text_files VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(directory, identity, JSON.stringify(names));
      row = query.get(directory, identity);
    }

    const names = JSON.parse(row.names_json);

    if (!Array.isArray(names) || names.some(name => !/^[^/\\]+\.(md|txt)$/.test(name) || storagePath.basename(name) !== name)) throw new Error('Invalid goal text file list');

    return names;
  } finally { db.close(); }
}

function validateGoalDirectory(directory) {
  const objective = storagePath.join(directory, "goal-objective.md");

  try {
    if (!storageFs.lstatSync(directory).isDirectory() || !storageFs.lstatSync(objective).isFile()) throw new Error("Invalid goal attachment");

    return goalTextFiles(directory).flatMap(name => {
      const file = storagePath.join(directory, name);

      if (!storageFs.lstatSync(file).isFile()) throw new Error('Goal text is not a regular file');

      return [...managedGoalReferences(storageFs.readFileSync(file, "utf8"))];
    });
  } catch (error) { throw new Error(`Managed goal attachment is unavailable: ${directory}. Reattach it before saving. ${error.message}`); }
}

function validateNewGoalReferences(incoming, previous) {
  const retained = new Set(previous);
  const pending = new Set(incoming);

  for (const directory of pending) {
    if (retained.has(directory)) continue;
    retained.add(directory);

    for (const dependency of validateGoalDirectory(directory)) pending.add(dependency);
  }
}

export function validateSessionReferencePublication(entries, previous = inheritedSessionEntries(entries)) {
  const incoming = managedGoalReferences(entries);
  validateNewGoalReferences(incoming, managedGoalReferences(previous));

  return incoming;
}

function storedSessionEntries(path) {
  const body = storageReadOptional(path);

  return body ? body.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)) : [];
}

function sessionParentPath(entry) {
  if (entry?.type === "session") return entry.parentSession;

  if (entry?.type === "custom" && entry.customType === "piop-subagent-parent") return entry.data?.parentSessionPath;
}

function inheritedSessionEntries(entries) {
  const parents = entries.map(sessionParentPath).filter(path => path?.constructor === String && storagePath.isAbsolute(path));

  return [...new Set(parents)].flatMap(storedSessionEntries);
}

export function acquireSessionReferencePublication(transcript) {
  const root = sessionReferenceRoot();
  storageFs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = storageFs.openSync(storagePath.join(root, "reference-publication.lock"), storageFs.constants.O_CREAT | storageFs.constants.O_RDWR | storageFs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!storageFs.fstatSync(descriptor).isFile()) throw new Error("Invalid reference publication lock");
    const locked = storageSpawn("flock", ["--shared", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] });

    if (locked.error) throw locked.error;

    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || "Could not lock reference publication");
    registerExternalTranscript(root, transcript);

    return () => storageFs.closeSync(descriptor);
  } catch (error) { storageFs.closeSync(descriptor); throw error; }
}

function storageSyncDirectory(path) {
  const descriptor = storageFs.openSync(path, storageFs.constants.O_RDONLY | storageFs.constants.O_NOFOLLOW);

  try { storageFs.fsyncSync(descriptor); }
  finally { storageFs.closeSync(descriptor); }
}

function storageReadOptional(path) {
  try { return storageFs.readFileSync(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function storageMetadata(path) {
  try { return storageFs.statSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function storageTarget(path) {
  try { return storageFs.realpathSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  return path;
}

function storageWritePrepared(path, temporary, body) {
  const previous = storageMetadata(path);
  storageFs.rmSync(temporary, { force: true });
  const descriptor = storageFs.openSync(temporary, "wx", 0o600);

  try {
    storageFs.writeFileSync(descriptor, body, "utf8");

    if (previous) {
      const created = storageFs.fstatSync(descriptor);

      if (created.uid !== previous.uid || created.gid !== previous.gid) storageFs.fchownSync(descriptor, previous.uid, previous.gid);
      storageFs.fchmodSync(descriptor, previous.mode & 0o777);
    }

    storageFs.fsyncSync(descriptor);
  } finally { storageFs.closeSync(descriptor); }
}

function storagePublish(path, temporary, body, exclusive) {
  try {
    storageWritePrepared(path, temporary, body);

    if (exclusive) storageFs.linkSync(temporary, path);
    else storageFs.renameSync(temporary, path);
    storageSyncDirectory(storagePath.dirname(path));
  } finally { storageFs.rmSync(temporary, { force: true }); }
}

function storageWriteAuth(path, body) {
  const target = storageTarget(path);
  const temporary = storagePath.join(storagePath.dirname(target), `.${storagePath.basename(target)}.piop-pending`);
  storagePublish(target, temporary, body, false);
}

function requireStorageMethods(prototype, names) {
  if (names.some(name => !(prototype[name] instanceof Function))) throw new Error("This Pi SDK does not support Piop's storage protection. Update Piop before using this SDK.");
}

export function installAuthStorage(FileAuthStorageBackend) {
  if (installedStorageClasses.has(FileAuthStorageBackend)) return;
  const prototype = FileAuthStorageBackend.prototype;
  requireStorageMethods(prototype, ["ensureParentDir", "acquireLockSyncWithRetry", "acquireLockAsync", "withLock", "withLockAsync"]);

  prototype.withLock = function (fn) {
    this.ensureParentDir();
    const release = this.acquireLockSyncWithRetry(this.authPath);

    try {
      const { result, next } = fn(storageReadOptional(this.authPath));

      if (next !== undefined) storageWriteAuth(this.authPath, next);

      return result;
    } finally { release(); }
  };

  prototype.withLockAsync = async function (fn, options) {
    options?.signal?.throwIfAborted();
    this.ensureParentDir();
    let compromised;

    const check = () => {
      if (compromised) throw compromised;
      options?.signal?.throwIfAborted();
    };

    const release = await this.acquireLockAsync(options?.signal, error => { compromised = error; });

    try {
      check();
      const { result, next } = await fn(storageReadOptional(this.authPath));
      check();

      if (next !== undefined) storageWriteAuth(this.authPath, next);
      check();

      return result;
    } finally { try { await release(); } catch {} }
  };

  installedStorageClasses.add(FileAuthStorageBackend);
}

function sessionStorageState(manager) {
  if (failedSessionStorage.has(manager)) throw new Error("Session storage could not be rolled back safely. Reopen the conversation before continuing.");

  if (!Array.isArray(manager.fileEntries) || !(manager.byId instanceof Map)) throw new Error("This Pi SDK changed its session storage format. Update Piop before continuing.");
}

function sessionStorageTemporary(path) {
  const directory = path.endsWith(".jsonl") ? path.slice(0, -6) + ".snapshots" : path + ".snapshots";
  storageFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = storageFs.lstatSync(directory);

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Session storage must be a directory");

  return storagePath.join(directory, "sdk-session.pending");
}

function sessionStoragePublish(manager, entries, exclusive) {
  const path = manager.sessionFile;
  const release = acquireSessionReferencePublication(path);

  try {
    registerManagedTranscript(manager);
    const references = validateSessionReferencePublication(entries, exclusive ? undefined : storedSessionEntries(path));

    try { storagePublish(path, sessionStorageTemporary(path), entries.map(entry => JSON.stringify(entry) + "\n").join(""), exclusive); }
    catch (error) {
      if (storageFs.existsSync(path)) failedSessionStorage.add(manager);
      throw error;
    }

    finishManagedTranscript(manager);
    sessionReferenceBaselines.set(manager, { path, entries: manager.fileEntries, references });
  } finally { release(); }
}

function sessionStorageAppend(manager, entry) {
  const release = acquireSessionReferencePublication(manager.sessionFile);

  try {
    registerManagedTranscript(manager);
    const baseline = sessionReferenceBaselines.get(manager);
    const previous = baseline?.path === manager.sessionFile && baseline.entries === manager.fileEntries ? baseline.references : managedGoalReferences(manager.fileEntries);
    const references = managedGoalReferences([entry]);
    validateNewGoalReferences(references, previous);
    appendSessionStorage(manager, entry);
    finishManagedTranscript(manager);
    sessionReferenceBaselines.set(manager, { path: manager.sessionFile, entries: manager.fileEntries, references: new Set([...previous, ...references]) });
  }
  finally { release(); }
}

function appendSessionStorage(manager, entry) {
  const descriptor = storageFs.openSync(manager.sessionFile, storageFs.constants.O_WRONLY | storageFs.constants.O_APPEND | storageFs.constants.O_NOFOLLOW);

  try {
    const original = storageFs.fstatSync(descriptor);

    if (!original.isFile() || original.size === 0) throw new Error("The saved session changed unexpectedly. Reopen the conversation before continuing.");

    try {
      storageFs.writeFileSync(descriptor, JSON.stringify(entry) + "\n", "utf8");
      storageFs.fsyncSync(descriptor);
    } catch (error) {
      try { storageFs.ftruncateSync(descriptor, original.size); storageFs.fsyncSync(descriptor); }
      catch { failedSessionStorage.add(manager); }

      throw error;
    }
  } finally { try { storageFs.closeSync(descriptor); } catch {} }
}

function persistSessionEntry(manager, entry) {
  if (!manager.persist || !manager.sessionFile) return;

  if (manager.flushed) { sessionStorageAppend(manager, entry);

  return; }

  const conversation = entry.type === "message" && ["user", "assistant"].includes(entry.message.role);

  if (!conversation && !manager._hasConversation()) return;
  sessionStoragePublish(manager, [...manager.fileEntries, entry], true);
  manager.flushed = true;
}

export function installSessionStorage(SessionManager) {
  if (installedStorageClasses.has(SessionManager)) return;
  const prototype = SessionManager.prototype;
  requireStorageMethods(prototype, ["_appendEntry", "_persist", "_rewriteFile", "_hasConversation"]);

  prototype._appendEntry = function (entry) {
    sessionStorageState(this);
    persistSessionEntry(this, entry);
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  };

  prototype._rewriteFile = function () {
    sessionStorageState(this);

    if (this.persist && this.sessionFile) sessionStoragePublish(this, this.fileEntries, false);
  };

  const fork = SessionManager.forkFrom;

  if (fork instanceof Function) SessionManager.forkFrom = function (...args) {
    const release = acquireSessionReferencePublication();

    try {
      const session = fork.apply(this, args);
      registerExternalTranscript(sessionReferenceRoot(), session.sessionFile);
      registerManagedTranscript(session, true);

      return session;
    } finally { release(); }
  };

  installedStorageClasses.add(SessionManager);
}
