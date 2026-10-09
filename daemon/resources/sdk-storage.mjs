import { DatabaseSync as StorageDatabase } from "node:sqlite";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome, tmpdir as storageTemporaryDirectory } from "node:os";
import { spawnSync as storageSpawn } from "node:child_process";
import { createHash as storageHash } from "node:crypto";
import { isDeepStrictEqual as sameStorageValue } from "node:util";
import { pathToFileURL as storageFileUrl } from "node:url";

const installedStorageClasses = new WeakSet();

const failedSessionStorage = new WeakSet();

const sessionReferenceBaselines = new WeakMap();

const sessionReferenceRecorders = new WeakMap();

export async function installRuntimeStorage(directory) {
  const modules = ["core/auth-storage.js", "core/models-store.js", "core/model-config.js", "core/settings-manager.js", "core/trust-manager.js", "utils/paths.js"];
  const [auth, models, config, settings, trust, paths] = await Promise.all(modules.map(file => import(storageFileUrl(storagePath.join(directory, "dist", file)).href)));
  installAuthStorage(auth.FileAuthStorageBackend, auth.AuthStorage);
  installModelsStorage(models.FileModelsStore, config.ModelConfig);
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

  if (["sessions", "archived", "fork-transactions", "fork-preparations"].some(area => relative.startsWith(area + storagePath.sep))) return;
  const databasePath = storagePath.join(root, "sessions.sqlite");
  storageFs.closeSync(storageFs.openSync(databasePath, "a", 0o600));
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

function finishManagedTranscript(manager, entries, entry) {
  try {
    registerManagedTranscript(manager, true);
    sessionReferenceRecorders.get(Object.getPrototypeOf(manager))?.(sessionReferenceRoot(), manager.sessionFile, entries, entry);
  }
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
  const pattern = new RegExp(`^${escaped}/(?:sessions|archived|fork-transactions|fork-preparations)/(?:[^\\r\\n]*?/)?attachments/goal-(?:[a-f0-9]{64}|[A-Za-z0-9]{6})(?![A-Za-z0-9_-])`);
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

    const contents = names.map(name => ({ name, text: importGoalText(storagePath.join(directory, name)) }));
    const after = storageFs.lstatSync(directory, { bigint: true });

    if (`${after.dev}:${after.ino}` !== identity) throw new Error('Goal text directory changed during import');
    db.prepare('INSERT INTO goal_text_contents VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(directory, identity, JSON.stringify(contents));

    return JSON.parse(db.prepare('SELECT contents_json FROM goal_text_contents WHERE directory=? AND identity=?').get(directory, identity).contents_json);
  } finally { db.close(); }
}

function importGoalText(file) {
  const descriptor = storageFs.openSync(file, storageFs.constants.O_RDONLY | storageFs.constants.O_NOFOLLOW | storageFs.constants.O_NONBLOCK);

  try {
    const before = storageFs.fstatSync(descriptor, { bigint: true });

    if (!before.isFile()) throw new Error('Goal text is not a regular file');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(storageFs.readFileSync(descriptor));
    const after = storageFs.lstatSync(file, { bigint: true });

    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Goal text changed during import');

    return text;
  } finally { storageFs.closeSync(descriptor); }
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

export function acquireSessionReferencePublication(transcript, sessionId) {
  const root = sessionReferenceRoot();
  storageFs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = storageFs.openSync(storagePath.join(root, "reference-publication.lock"), storageFs.constants.O_CREAT | storageFs.constants.O_RDWR | storageFs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!storageFs.fstatSync(descriptor).isFile()) throw new Error("Invalid reference publication lock");
    const locked = storageSpawn("flock", ["--shared", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] });

    if (locked.error) throw locked.error;

    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || "Could not lock reference publication");
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

function withStoredAuth(path, operation) {
  const target = storageTarget(path);
  const directory = storagePath.dirname(target);
  storageFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = storagePath.join(directory, "piop-accounts.sqlite");
  storageFs.closeSync(storageFs.openSync(file, storageFs.constants.O_CREAT | storageFs.constants.O_RDWR | storageFs.constants.O_NOFOLLOW, 0o600));
  storageFs.chmodSync(file, 0o600);
  const database = new StorageDatabase(file);
  const key = storagePath.basename(target);

  try {
    database.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS provider_credentials (auth_file TEXT PRIMARY KEY, body TEXT, revision INTEGER NOT NULL);
      BEGIN IMMEDIATE;`);

    if (!database.prepare("SELECT 1 FROM provider_credentials WHERE auth_file=?").get(key)) {
      database.prepare("INSERT INTO provider_credentials VALUES (?, ?, 0)").run(key, storageReadOptional(target) ?? null);
    }

    const result = operation(database, key);
    database.exec("COMMIT");

    return result;
  } finally { database.close(); }
}

function storageReadAuth(path) {
  return withStoredAuth(path, (database, key) => database.prepare("SELECT body FROM provider_credentials WHERE auth_file=?").get(key).body ?? undefined);
}

function storageWriteAuth(path, body) {
  withStoredAuth(path, (database, key) => database.prepare("UPDATE provider_credentials SET body=?, revision=revision+1 WHERE auth_file=?").run(body, key));
}

export function storedAuthRevision(path) {
  return withStoredAuth(path, (database, key) => database.prepare("SELECT revision FROM provider_credentials WHERE auth_file=?").get(key).revision);
}

export function storedModelText(path) {
  return storageReadAuth(path);
}

export function saveStoredModelProvider(path, id, config, previous, parse) {
  return withStoredAuth(path, (database, key) => {
    const body = database.prepare("SELECT body FROM provider_credentials WHERE auth_file=?").get(key).body;
    const data = body ? parse(body) : { providers: {} };

    if (!data.providers || Object.getPrototypeOf(data.providers) !== Object.prototype) throw new Error("Invalid saved provider settings");
    const current = data.providers[id];

    if (previous === undefined && Object.hasOwn(data.providers, id)) throw new Error("That provider ID already exists");

    if (previous !== undefined && !sameStorageValue(current, previous)) throw new Error("Provider settings changed. Refresh before saving.");

    if (sameStorageValue(current, config)) return true;
    Object.defineProperty(data.providers, id, { value: config, enumerable: true, writable: true, configurable: true });
    database.prepare("UPDATE provider_credentials SET body=?, revision=revision+1 WHERE auth_file=?").run(JSON.stringify(data), key);

    return true;
  });
}

function installModelConfiguration(ModelConfig) {
  if (installedStorageClasses.has(ModelConfig)) return;
  requireStorageMethods(ModelConfig, ["load"]);
  const load = ModelConfig.load.bind(ModelConfig);
  let cached;

  ModelConfig.load = async (path) => {
    if (!path) return load(path);
    const body = storedModelText(path);

    if (cached?.path === path && cached.body === body) return cached.value;
    const value = body === undefined ? await load(undefined) : await loadModelCopy(load, path, body);
    cached = { path, body, value };

    return value;
  };

  installedStorageClasses.add(ModelConfig);
}

async function loadModelCopy(load, path, body) {
  const directory = storageFs.mkdtempSync(storagePath.join(storageTemporaryDirectory(), "piop-model-config-"));
  const file = storagePath.join(directory, "models.json");

  try {
    storageFs.writeFileSync(file, body, { mode: 0o600 });
    const result = await load(file);

    if (result.error) result.error = result.error.replaceAll(file, path);

    return result;
  } finally { storageFs.rmSync(directory, { recursive: true, force: true }); }
}

export function installModelsStorage(FileModelsStore, ModelConfig) {
  installModelConfiguration(ModelConfig);

  if (installedStorageClasses.has(FileModelsStore)) return;
  const prototype = FileModelsStore.prototype;
  requireStorageMethods(prototype, ["readLatest", "reloadFromStorage", "parse", "updateReadState"]);

  prototype.reloadFromStorage = function (readState, options) {
    return this.storage.withLockAsync(async (content) => {
      const data = this.parse(content);
      this.updateReadState(readState, data, storedAuthRevision(this.path));

      return { result: data };
    }, options);
  };

  prototype.readLatest = async function (readState, options) {
    options?.signal?.throwIfAborted();
    const revision = storedAuthRevision(this.path);

    return revision === readState.revision ? readState.data : this.reloadFromStorage(readState, options);
  };

  installedStorageClasses.add(FileModelsStore);
}

function requireStorageMethods(prototype, names) {
  if (names.some(name => !(prototype[name] instanceof Function))) throw new Error("This Pi SDK does not support Piop's storage protection. Update Piop before using this SDK.");
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
  storageFs.closeSync(storageFs.openSync(file, storageFs.constants.O_CREAT | storageFs.constants.O_RDWR | storageFs.constants.O_NOFOLLOW, 0o600));
  storageFs.chmodSync(file, 0o600);
  const database = new StorageDatabase(file);
  const key = storagePath.resolve(path);

  try {
    database.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sdk_settings (path TEXT PRIMARY KEY, body TEXT);
      BEGIN IMMEDIATE;`);

    if (!database.prepare("SELECT 1 FROM sdk_settings WHERE path=?").get(key)) {
      database.prepare("INSERT INTO sdk_settings VALUES (?, ?)").run(key, storageReadOptional(key) ?? null);
    }

    const current = database.prepare("SELECT body FROM sdk_settings WHERE path=?").get(key).body;
    const next = operation(current ?? undefined);

    if (next !== undefined) database.prepare("UPDATE sdk_settings SET body=? WHERE path=?").run(next, key);
    database.exec("COMMIT");
  } finally { database.close(); }
}

export function installAuthStorage(FileAuthStorageBackend, AuthStorage) {
  if (installedStorageClasses.has(FileAuthStorageBackend)) return;
  const prototype = FileAuthStorageBackend.prototype;
  requireStorageMethods(prototype, ["ensureParentDir", "acquireLockSyncWithRetry", "acquireLockAsync", "withLock", "withLockAsync"]);
  requireStorageMethods(AuthStorage, ["create", "fromStorage"]);
  AuthStorage.create = (path) => AuthStorage.fromStorage(new FileAuthStorageBackend(path));

  prototype.withLock = function (fn) {
    this.ensureParentDir();
    const release = this.acquireLockSyncWithRetry(this.authPath);

    try {
      const { result, next } = fn(storageReadAuth(this.authPath));

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
      const { result, next } = await fn(storageReadAuth(this.authPath));
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
  const release = acquireSessionReferencePublication(path, entries[0]?.id);

  try {
    registerManagedTranscript(manager);
    const references = validateSessionReferencePublication(entries, exclusive ? undefined : storedSessionEntries(path));

    try { storagePublish(path, sessionStorageTemporary(path), entries.map(entry => JSON.stringify(entry) + "\n").join(""), exclusive); }
    catch (error) {
      if (storageFs.existsSync(path)) failedSessionStorage.add(manager);
      throw error;
    }

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

function registeredSessionPath(id, directory) {
  const root = sessionReferenceRoot();
  const database = new StorageDatabase(storagePath.join(root, "sessions.sqlite"));

  try {
    database.exec("PRAGMA busy_timeout=10000;");

    const row = database.prepare(`SELECT session_path FROM sessions WHERE session_id=?
      AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))`).get(id, id);

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

  const fork = SessionManager.forkFrom;

  if (fork instanceof Function) SessionManager.forkFrom = function (...args) {
    const release = acquireSessionReferencePublication();

    try {
      const session = fork.apply(this, args);
      registerExternalTranscript(sessionReferenceRoot(), session.sessionFile, session.getSessionId());
      registerManagedTranscript(session, true);

      return session;
    } finally { release(); }
  };

  installedStorageClasses.add(SessionManager);
}
