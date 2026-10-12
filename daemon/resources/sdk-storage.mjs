import { lockSync as storageLockSync } from "./file-lock.cjs";
import { createRequire as storageRequire } from "node:module";
import * as sessionTables from "./session-database.cjs";
import { DatabaseSync as StorageDatabase } from "node:sqlite";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";
import { createHash as storageHash, randomUUID as storageRandomId } from "node:crypto";
import { isDeepStrictEqual as sameStorageValue } from "node:util";
import { pathToFileURL as storageFileUrl } from "node:url";

const installedStorageClasses = new WeakSet();

let modelFileStorage;

const failedSessionStorage = new WeakSet();

const sessionStorageFiles = new WeakMap();

const sessionReferenceBaselines = new WeakMap();

const sessionReferenceRecorders = new WeakMap();

export async function installRuntimeStorage(directory) {
  const modules = ["core/auth-storage.js", "core/settings-manager.js", "core/trust-manager.js", "utils/paths.js"];
  const [auth, settings, trust, paths] = await Promise.all(modules.map(file => import(storageFileUrl(storagePath.join(directory, "dist", file)).href)));
  modelFileStorage = auth.FileAuthStorageBackend;
  installAuthStorage(auth.FileAuthStorageBackend);
  installSettingsStorage(settings.FileSettingsStorage);
  installTrustStorage(trust.ProjectTrustStore, path => paths.canonicalizePath(paths.resolvePath(path)));
}

function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

function registerExternalTranscript(root, transcript, sessionId) {
  if (!transcript) return;
  const file = storagePath.resolve(transcript);
  const relative = storagePath.relative(root, file);

  if (["sessions", "archived"].some(area => relative.startsWith(area + storagePath.sep))) return;
  const databasePath = storagePath.join(root, "sessions.sqlite");
  if (storageFs.lstatSync(databasePath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Database path must not be a symbolic link");
  const database = new StorageDatabase(databasePath);

  try {
    storageFs.chmodSync(databasePath, 0o600);
    database.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    database.prepare("INSERT INTO external_transcripts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=json_patch(external_transcripts.record_json, excluded.record_json)")
      .run(storageHash("sha256").update(file).digest("hex"), JSON.stringify({ path: file, sessionId }));
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
  const database = sessionTables.open(root);

  try {
    database.exec("BEGIN IMMEDIATE;");
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

function finishManagedTranscript(manager, entries, entry) {
  try {
    registerManagedTranscript(manager, true);
    sessionReferenceRecorders.get(Object.getPrototypeOf(manager))?.(sessionReferenceRoot(), manager.sessionFile, entries, entry);
  }
  catch (error) { failedSessionStorage.add(manager); throw error; }
}

function registerManagedPath(database, sessionId, file) {
  sessionTables.register(database, sessionId, file);
}

function bindNewSession(manager) {
  const database = sessionTables.open(sessionReferenceRoot());

  try { sessionTables.bind(database, manager.getSessionId(), manager.sessionFile); }
  finally { database.close(); }
}

function installSessionCreation(SessionManager) {
  const prototype = SessionManager.prototype;
  requireStorageMethods(prototype, ["newSession", "_loadEntries", "_setSessionFile"]);
  requireStorageMethods(SessionManager, ["open"]);
  const create = prototype.newSession;
  const load = prototype._loadEntries;
  const setFile = prototype._setSessionFile;
  const open = SessionManager.open;

  SessionManager.open = function (path, ...args) {
    if (storageFs.existsSync(path)) storedSessionEntries(path, {});
    return open.call(this, path, ...args);
  };

  prototype._setSessionFile = function (path, entries) {
    if (this.persist && storageFs.existsSync(path)) entries = storedSessionEntries(path, this);
    return setFile.call(this, path, entries);
  };

  prototype.newSession = function (options) {
    if (!this.persist) return create.call(this, options);
    const id = options?.id ?? sessionTables.reserve(sessionReferenceRoot());
    const result = create.call(this, { ...options, id });
    bindNewSession(this);
    sessionStoragePublish(this, this.fileEntries, true);
    this.flushed = true;

    return result;
  };

  prototype._loadEntries = function (entries, options) {
    if (this.persist && this.sessionFile) entries = storedSessionEntries(this.sessionFile, this);
    const header = entries.find(entry => entry.type === "session");

    if (this.persist && header) {
      const database = sessionTables.open(sessionReferenceRoot());

      try { sessionTables.register(database, header.id, this.sessionFile); }
      finally { database.close(); }
    }

    return load.call(this, entries, options);
  };

  SessionManager.forkFrom = function (sourcePath, targetCwd, sessionDir, options) {
    const source = this.open(sourcePath);
    const session = this.create(targetCwd, sessionDir, { ...options, parentSession: sourcePath });
    session.fileEntries = [session.fileEntries[0], ...structuredClone(source.fileEntries.filter(entry => entry.type !== "session"))];
    session._buildIndex();
    storageRequire(import.meta.url)("./session-broker/goal-storage.cjs").copy(sessionReferenceRoot(), source.getSessionId(), session.getSessionId());
    sessionStoragePublish(session, session.fileEntries, false);
    session.flushed = true;

    return session;
  };

  installSessionBranching(prototype);
}

function installSessionBranching(prototype) {
  requireStorageMethods(prototype, ["createBranchedSession"]);
  const branch = prototype.createBranchedSession;

  prototype.createBranchedSession = function (...args) {
    if (!this.persist) return branch.apply(this, args);
    const parent = this.sessionFile;
    const sourceId = this.getSessionId();
    this.persist = false;

    try { branch.apply(this, args); }
    finally { this.persist = true; }

    const id = sessionTables.reserve(sessionReferenceRoot());
    const header = this.fileEntries[0];
    this.sessionId = id;
    header.id = id;
    header.parentSession = parent;
    this.sessionFile = storagePath.join(this.getSessionDir(), `${header.timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    bindNewSession(this);
    storageRequire(import.meta.url)("./session-broker/goal-storage.cjs").copy(sessionReferenceRoot(), sourceId, this.getSessionId());
    sessionStoragePublish(this, this.fileEntries, true);
    this.flushed = true;

    return this.sessionFile;
  };
}

function textGoalReferences(text, root, found) {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}/(?:sessions|archived)/(?:[^\\r\\n]*?/)?attachments/goal-(?:[a-f0-9]{64}|[A-Za-z0-9]{6})(?![A-Za-z0-9_-])`);
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

function goalTextContents(directory) {
  const info = storageFs.lstatSync(directory, { bigint: true });
  const identity = `${info.dev}:${info.ino}`;
  const file = storagePath.join(sessionReferenceRoot(), 'sessions.sqlite');
  const db = new StorageDatabase(file);

  try {
    storageFs.chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS goal_text_files (directory TEXT NOT NULL, identity TEXT NOT NULL, names_json TEXT NOT NULL, PRIMARY KEY(directory, identity));
      CREATE TABLE IF NOT EXISTS goal_text_contents (directory TEXT NOT NULL, identity TEXT NOT NULL, contents_json TEXT NOT NULL, PRIMARY KEY(directory, identity));`);
    const saved = db.prepare("SELECT contents_json FROM goal_text_contents WHERE directory=? AND identity=?").get(directory, identity);

    if (saved) return JSON.parse(saved.contents_json);
    throw new Error('Goal text contents are not registered');
  } finally { db.close(); }
}

function validateGoalDirectory(directory) {
  const objective = storagePath.join(directory, "goal-objective.md");

  try {
    if (!storageFs.lstatSync(directory).isDirectory() || !storageFs.lstatSync(objective).isFile()) throw new Error("Invalid goal attachment");

    return goalTextContents(directory).flatMap(entry => [...managedGoalReferences(entry.text)]);
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

function storedSessionEntries(path, manager) {
  let descriptor;
  try { descriptor = storageFs.openSync(path, (manager ? storageFs.constants.O_RDWR : storageFs.constants.O_RDONLY) | storageFs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT" && !manager) return []; throw error; }
  let body;

  try {
    const original = storageFs.fstatSync(descriptor);
    if (!original.isFile()) throw new Error(`Session storage is not a regular file: ${path}`);
    body = storageFs.readFileSync(descriptor);
    const end = body.lastIndexOf(10) + 1;
    if (manager) {
      const current = storageFs.lstatSync(path);
      if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || body.length !== original.size) throw new Error(`The saved session changed unexpectedly: ${path}`);
    }

    if (end !== body.length) {
      const dropped = body.length - end;
      if (manager) {
        storageFs.ftruncateSync(descriptor, end);
        storageFs.fsyncSync(descriptor);
      }
      console.warn(`${path}: last write was interrupted; ${manager ? "dropped" : "ignored"} ${dropped} bytes`);
      body = body.subarray(0, end);
    }
    if (manager) sessionStorageFiles.set(manager, { path, ...storageFs.fstatSync(descriptor) });
  } finally { storageFs.closeSync(descriptor); }
  const lines = body.toString("utf8").split("\n");
  lines.pop();

  return lines.map((line, index) => {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.type !== "string") throw new Error("Invalid record");
      return entry;
    } catch { throw new Error(`Damaged chat record at line ${index + 1}: ${path}`); }
  });
}

function sessionParentPath(entry) {
  if (entry?.type === "session") return entry.parentSession;

  if (entry?.type === "custom" && entry.customType === "piop-subagent-parent") return entry.data?.parentSessionPath;
}

function inheritedSessionEntries(entries) {
  const parents = entries.map(sessionParentPath).filter(path => path?.constructor === String && storagePath.isAbsolute(path));

  return [...new Set(parents)].flatMap(path => storedSessionEntries(path));
}

export function acquireSessionReferencePublication(transcript, sessionId) {
  const root = sessionReferenceRoot();
  storageFs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = storageFs.openSync(storagePath.join(root, "reference-publication.lock"), storageFs.constants.O_CREAT | storageFs.constants.O_RDWR | storageFs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!storageFs.fstatSync(descriptor).isFile()) throw new Error("Invalid reference publication lock");
    const locked = storageLockSync(descriptor, true, false);

    if (!locked) throw new Error("Could not lock reference publication");
    registerExternalTranscript(root, transcript, sessionId);

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

export function storedModelText(path) {
  try { return storageFs.readFileSync(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function modelProviderData(body, parse) {
  const data = body ? parse(body) : {};

  if (!data || Object.getPrototypeOf(data) !== Object.prototype) throw new Error("Invalid saved provider settings");

  if (!Object.hasOwn(data, "providers")) data.providers = {};

  if (!data.providers || Object.getPrototypeOf(data.providers) !== Object.prototype) throw new Error("Invalid saved provider settings");

  return data;
}

export function saveStoredModelProvider(path, id, config, previous, parse) {
  return new modelFileStorage(path).withLock(body => {
    const data = modelProviderData(body, parse);
    const current = data.providers[id];

    if (previous === undefined && Object.hasOwn(data.providers, id)) throw new Error("That provider ID already exists");

    if (previous !== undefined && !sameStorageValue(current, previous)) throw new Error("Provider settings changed. Refresh before saving.");

    if (sameStorageValue(current, config)) return { result: true };
    Object.defineProperty(data.providers, id, { value: config, enumerable: true, writable: true, configurable: true });

    return { result: true, next: JSON.stringify(data, null, 2) };
  });
}

function requireStorageMethods(prototype, names) {
  if (names.some(name => !(prototype[name] instanceof Function))) throw new Error("This Pi SDK does not support Piop's storage protection. Update Piop before using this SDK.");
}

/** Replaces the file in one step, so a crash or a full disk cannot leave credentials or provider settings empty or partial. */
function publishAuthFile(path, body) {
  const target = storageTarget(path);
  const temporary = storagePath.join(storagePath.dirname(target), `.${storagePath.basename(target)}.${storageRandomId()}.tmp`);

  storagePublish(target, temporary, body, false);
}

/** The SDK writes auth.json and models.json in place; this keeps its lock and changes only the write. */
function installAuthStorage(FileAuthStorageBackend) {
  if (installedStorageClasses.has(FileAuthStorageBackend)) return;
  const prototype = FileAuthStorageBackend.prototype;
  requireStorageMethods(prototype, ["withLock", "withLockAsync"]);
  const withLock = prototype.withLock;
  const withLockAsync = prototype.withLockAsync;

  prototype.withLock = function (operation) {
    return withLock.call(this, current => {
      const { result, next } = operation(current);

      if (next !== undefined) publishAuthFile(this.authPath, next);

      return { result };
    });
  };

  prototype.withLockAsync = function (operation, options) {
    return withLockAsync.call(this, async current => {
      const { result, next } = await operation(current);

      options?.signal?.throwIfAborted();

      if (next !== undefined) publishAuthFile(this.authPath, next);

      return { result };
    }, options);
  };

  installedStorageClasses.add(FileAuthStorageBackend);
}

export function installSettingsStorage(FileSettingsStorage) {
  if (installedStorageClasses.has(FileSettingsStorage)) return;
  requireStorageMethods(FileSettingsStorage.prototype, ["withLock"]);

  FileSettingsStorage.prototype.withLock = function (scope, operation) {
    if (!["global", "project"].includes(scope)) throw new Error("Invalid settings scope");
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;

    return withStoredSettings(path, operation);
  };

  installedStorageClasses.add(FileSettingsStorage);
}

function trustDecisions(body) {
  const data = JSON.parse((body ?? "{}").replace(/^\uFEFF/, ""));

  if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.values(data).some(value => ![true, false, null].includes(value))) throw new Error("Invalid saved project trust decisions");

  return data;
}

function nearestTrustDecision(data, path) {
  for (let current = path; ; current = storagePath.dirname(current)) {
    const decision = data[current];

    if (decision === true || decision === false) return { path: current, decision };

    if (current === storagePath.dirname(current)) return null;
  }
}

function installTrustStorage(ProjectTrustStore, normalize) {
  if (installedStorageClasses.has(ProjectTrustStore)) return;
  requireStorageMethods(ProjectTrustStore.prototype, ["getEntry", "setMany"]);

  ProjectTrustStore.prototype.getEntry = function (cwd) {
    let entry;
    withStoredSettings(this.trustPath, body => {
      entry = nearestTrustDecision(trustDecisions(body), normalize(cwd));
    });

    return entry;
  };

  ProjectTrustStore.prototype.setMany = function (decisions) {
    withStoredSettings(this.trustPath, body => {
      const data = trustDecisions(body);

      for (const { path, decision } of decisions) {
        if (![true, false, null].includes(decision)) throw new Error("Invalid project trust decision");
        const key = normalize(path);

        if (decision === null) delete data[key];
        else data[key] = decision;
      }

      return JSON.stringify(data);
    });
  };

  installedStorageClasses.add(ProjectTrustStore);
}

function withStoredSettings(path, operation) {
  const root = sessionReferenceRoot();
  storageFs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = storagePath.join(root, "sessions.sqlite");
  if (storageFs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Database path must not be a symbolic link");
  const database = new StorageDatabase(file);
  const key = storagePath.resolve(path);

  try {
    storageFs.chmodSync(file, 0o600);
    database.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sdk_settings (path TEXT PRIMARY KEY, body TEXT);
      BEGIN IMMEDIATE;`);

    if (!database.prepare("SELECT 1 FROM sdk_settings WHERE path=?").get(key)) {
      database.prepare("INSERT INTO sdk_settings VALUES (?, ?)").run(key, null);
    }

    const current = database.prepare("SELECT body FROM sdk_settings WHERE path=?").get(key).body;
    const next = operation(current ?? undefined);

    if (next !== undefined) database.prepare("UPDATE sdk_settings SET body=? WHERE path=?").run(next, key);
    database.exec("COMMIT");
  } finally { database.close(); }
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
  const release = acquireSessionReferencePublication(path, entries[0]?.id);

  try {
    registerManagedTranscript(manager);
    const references = validateSessionReferencePublication(entries, exclusive ? undefined : storedSessionEntries(path));

    try { storagePublish(path, sessionStorageTemporary(path), entries.map(entry => JSON.stringify(entry) + "\n").join(""), exclusive); }
    catch (error) {
      if (storageFs.existsSync(path)) failedSessionStorage.add(manager);
      throw error;
    }

    sessionStorageFiles.set(manager, { path, ...storageFs.lstatSync(path) });
    finishManagedTranscript(manager, entries);
    sessionReferenceBaselines.set(manager, { path, entries: manager.fileEntries, references });
  } finally { release(); }
}

function sessionStorageAppend(manager, entry) {
  const release = acquireSessionReferencePublication(manager.sessionFile, manager.fileEntries[0]?.id);

  try {
    registerManagedTranscript(manager);
    const baseline = sessionReferenceBaselines.get(manager);
    const previous = baseline?.path === manager.sessionFile && baseline.entries === manager.fileEntries ? baseline.references : managedGoalReferences(manager.fileEntries);
    const references = managedGoalReferences([entry]);
    validateNewGoalReferences(references, previous);
    appendSessionStorage(manager, entry);
    finishManagedTranscript(manager, manager.fileEntries, entry);
    sessionReferenceBaselines.set(manager, { path: manager.sessionFile, entries: manager.fileEntries, references: new Set([...previous, ...references]) });
  }
  finally { release(); }
}

function appendSessionStorage(manager, entry) {
  const path = manager.sessionFile;
  const original = storageFs.lstatSync(path);
  const expected = sessionStorageFiles.get(manager);

  if (!original.isFile() || original.size === 0 || expected?.path !== path || original.dev !== expected.dev || original.ino !== expected.ino || original.size !== expected.size) throw new Error("The saved session changed unexpectedly. Reopen the conversation before continuing.");
  const line = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
  const descriptor = storageFs.openSync(path, storageFs.constants.O_WRONLY | storageFs.constants.O_APPEND | storageFs.constants.O_NOFOLLOW);

  try {
    const opened = storageFs.fstatSync(descriptor);
    const current = storageFs.lstatSync(path);
    if (opened.dev !== original.dev || opened.ino !== original.ino || opened.size !== original.size || current.dev !== original.dev || current.ino !== original.ino) throw new Error("The saved session changed unexpectedly. Reopen the conversation before continuing.");
    if (storageFs.writeSync(descriptor, line) !== line.length) throw new Error(`Session append was incomplete: ${path}`);
    storageFs.fsyncSync(descriptor);
    const saved = storageFs.fstatSync(descriptor);
    const published = storageFs.lstatSync(path);
    if (saved.size !== original.size + line.length || published.dev !== saved.dev || published.ino !== saved.ino || published.size !== saved.size) throw new Error(`The saved session changed during append: ${path}`);
    sessionStorageFiles.set(manager, { path, ...saved });
  }
  catch (error) { failedSessionStorage.add(manager); throw error; }
  finally { storageFs.closeSync(descriptor); }
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

function registeredSessionPath(id, directory) {
  const root = sessionReferenceRoot();
  const database = new StorageDatabase(storagePath.join(root, "sessions.sqlite"));

  try {
    database.exec("PRAGMA busy_timeout=10000;");

    const row = database.prepare(`SELECT session_path FROM sessions WHERE session_id=?`).get(id);

    return row?.session_path && storageTarget(storagePath.dirname(row.session_path)) === directory ? row.session_path : undefined;
  } finally { database.close(); }
}

export function sessionHeaderMatches(file, id, cwd) {
  let descriptor;

  try {
    descriptor = storageFs.openSync(file, storageFs.constants.O_RDONLY | storageFs.constants.O_NONBLOCK);

    if (!storageFs.fstatSync(descriptor).isFile()) return false;
    const buffer = Buffer.alloc(64 * 1024);
    const length = storageFs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]);

    return header.type === "session" && header.id === id && header.cwd?.constructor === String && header.cwd !== "" && storagePath.resolve(header.cwd) === storagePath.resolve(cwd);
  } catch { return false; }
  finally { if (descriptor !== undefined) storageFs.closeSync(descriptor); }
}

function installSessionLookup(SessionManager) {
  requireStorageMethods(SessionManager, ["findById"]);
  const find = SessionManager.findById;

  SessionManager.findById = function (cwd, id, sessionDir) {
    const root = storageTarget(sessionReferenceRoot());
    const directory = storageTarget(sessionDir ? storagePath.resolve(sessionDir) : storagePath.join(root, "sessions"));

    if (!["sessions", "archived"].some(area => directory === storagePath.join(root, area) || directory.startsWith(storagePath.join(root, area) + storagePath.sep))) return find.call(this, cwd, id, sessionDir);
    const file = registeredSessionPath(id, directory);

    return file && sessionHeaderMatches(file, id, cwd) ? file : undefined;
  };
}

export function installSessionStorage(SessionManager, recordReferences) {
  if (installedStorageClasses.has(SessionManager)) return;
  const prototype = SessionManager.prototype;
  requireStorageMethods(prototype, ["_appendEntry", "_persist", "_rewriteFile", "_hasConversation"]);
  installSessionLookup(SessionManager);
  installSessionCreation(SessionManager);

  if (recordReferences) sessionReferenceRecorders.set(prototype, recordReferences);

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

  installedStorageClasses.add(SessionManager);
}
