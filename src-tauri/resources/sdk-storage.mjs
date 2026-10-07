import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";
import { spawnSync as storageSpawn } from "node:child_process";
import { createHash as storageHash, randomUUID as storageUuid } from "node:crypto";

const installedStorageClasses = new WeakSet();

const failedSessionStorage = new WeakSet();

function registerExternalTranscript(root, transcript) {
  if (!transcript) return;
  const file = storagePath.resolve(transcript);
  const relative = storagePath.relative(root, file);

  if (["sessions", "archived", "fork-transactions", "fork-preparations"].some(area => relative.startsWith(area + storagePath.sep))) return;
  const directory = storagePath.join(root, "external-transcripts");
  storageFs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (!storageFs.lstatSync(directory).isDirectory()) throw new Error("Invalid external transcript registry");
  const record = storagePath.join(directory, storageHash("sha256").update(file).digest("hex") + ".json");
  const body = JSON.stringify({ path: file });

  if (storageReadOptional(record) === body) return;
  storagePublish(record, record + "." + storageUuid() + ".tmp", body, false);
  storageSyncDirectory(root);
}

export function acquireSessionReferencePublication(transcript) {
  const root = storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
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

  try { storagePublish(path, sessionStorageTemporary(path), entries.map(entry => JSON.stringify(entry) + "\n").join(""), exclusive); }
  catch (error) {
    if (storageFs.existsSync(path)) failedSessionStorage.add(manager);
    throw error;
  } finally { release(); }
}

function sessionStorageAppend(manager, entry) {
  const release = acquireSessionReferencePublication(manager.sessionFile);

  try { appendSessionStorage(manager, entry); }
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

  installedStorageClasses.add(SessionManager);
}
