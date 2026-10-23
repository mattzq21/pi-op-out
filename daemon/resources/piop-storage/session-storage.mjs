import * as stateRecords from "./session-records.cjs";
import { copy as copyGoal } from "./goals.cjs";
import { takeSessionId } from "./identities.mjs";
import { lockSync as storageLockSync } from "../file-lock.cjs";
import * as registry from "../session-registry.cjs";
import { DatabaseSync as StorageDatabase } from "node:sqlite";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";

import { storagePublish, storageTarget, requireStorageMethods } from "../storage-file.mjs";

const installedStorageClasses = new WeakSet();
const currentSessionState = new WeakMap();

function takeCurrentState(manager, entries) {
  currentSessionState.set(manager, new Map(entries.filter(stateRecords.isCurrent).map(entry => [stateRecords.stateKey(entry), { ...entry, parentId: null }])));
  return stateRecords.history(entries);
}

function currentEntries(manager) { return [...(currentSessionState.get(manager)?.values() ?? [])].sort((a, b) => stateRecords.stateKey(a).localeCompare(stateRecords.stateKey(b))); }

const failedSessionStorage = new WeakSet();

const sessionStorageFiles = new WeakMap();

const sessionReferenceBaselines = new WeakMap();

const sessionReferenceRecorders = new WeakMap();

function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

function registerManagedTranscript(manager, saved = false) {
  if (!manager.persist || !manager.sessionFile) return;
  const root = sessionReferenceRoot();
  const file = storagePath.resolve(manager.sessionFile);
  const area = storagePath.relative(root, file).split(storagePath.sep)[0];

  if (!["sessions", "archived"].includes(area)) return;
  const header = manager.fileEntries[0];

  if (header?.type !== "session" || !header.id || header.id !== String(header.id)) throw new Error("Cannot register a session without its saved identity");
  registry.recordTranscript(root, header.id, file, saved);
}

function finishManagedTranscript(manager, entries, entry) {
  try {
    registerManagedTranscript(manager, true);
    sessionReferenceRecorders.get(Object.getPrototypeOf(manager))?.(sessionReferenceRoot(), manager.sessionFile, entries, entry);
  }
  catch (error) { failedSessionStorage.add(manager); throw error; }
}

function bindNewSession(manager) {
  registry.bindSession(sessionReferenceRoot(), manager.getSessionId(), manager.sessionFile);
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
    if (!this.persist) { currentSessionState.set(this, new Map()); return create.call(this, options); }
    const id = options?.id ?? takeSessionId();
    currentSessionState.set(this, new Map());
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
      registry.requireSession(sessionReferenceRoot(), header.id, this.sessionFile);
    }

    return load.call(this, takeCurrentState(this, entries), options);
  };

  SessionManager.forkFrom = function (sourcePath, targetCwd, sessionDir, options) {
    const source = this.open(sourcePath);
    const session = this.create(targetCwd, sessionDir, { ...options, parentSession: sourcePath });
    session.fileEntries = [session.fileEntries[0], ...structuredClone(source.getEntries())];
    session._buildIndex();
    copyGoal(sourcePath, session.sessionFile, session.getSessionId());
    sessionStoragePublish(session, session.fileEntries, false);
    session.fileEntries = takeCurrentState(session, session.fileEntries);
    session._buildIndex();
    session.flushed = true;
    if (source.getLeafId() === null) session.resetLeaf();
    else session.branch(source.getLeafId());

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
    this.persist = false;

    try { branch.apply(this, args); }
    finally { this.persist = true; }

    const id = takeSessionId();
    const header = this.fileEntries[0];
    this.sessionId = id;
    header.id = id;
    header.parentSession = parent;
    this.sessionFile = storagePath.join(this.getSessionDir(), `${header.timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    bindNewSession(this);
    copyGoal(parent, this.sessionFile, id);
    sessionStoragePublish(this, this.fileEntries, true);
    this.fileEntries = takeCurrentState(this, this.fileEntries);
    this._buildIndex();
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

  return stateRecords.merge(path, lines.map((line, index) => {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.type !== "string") throw new Error("Invalid record");
      return entry;
    } catch { throw new Error(`Damaged chat record at line ${index + 1}: ${path}`); }
  }));
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
    registry.registerExternalTranscript(root, transcript, sessionId);

    return () => storageFs.closeSync(descriptor);
  } catch (error) { storageFs.closeSync(descriptor); throw error; }
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

    stateRecords.save(path, entries);
    try { storagePublish(path, sessionStorageTemporary(path), stateRecords.stored(entries).map(entry => JSON.stringify(entry) + "\n").join(""), exclusive); }
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
    if (entry.type === "custom" || stateRecords.isCurrent(entry)) {
      const after = manager.fileEntries.findLast(item => item.type !== "session" && item.type !== "custom")?.id ?? null;
      stateRecords.append(manager.sessionFile, manager.getSessionId(), after, entry);
    } else appendSessionStorage(manager, entry);
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
  const file = registry.sessionPath(sessionReferenceRoot(), id);
  return file && storageTarget(storagePath.dirname(file)) === directory ? file : undefined;
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

  const buildIndex = prototype._buildIndex;
  prototype._buildIndex = function () {
    buildIndex.call(this);
    if (!this.persist || !this.sessionFile) return;
    const tip = this.fileEntries.findLast(entry => entry.type !== "session" && !stateRecords.isCurrent(entry))?.id ?? null;
    const leaf = stateRecords.selectedLeaf(this.sessionFile, this.getSessionId(), tip);
    if (leaf !== null && !this.byId.has(leaf)) throw new Error("The saved branch points to a missing entry");
    this.leafId = leaf;
  };

  const selectBranch = (manager, leaf) => {
    sessionStorageState(manager);
    if (leaf !== null && !manager.byId.has(leaf)) throw new Error(`Entry ${leaf} not found`);
    const tip = manager.fileEntries.findLast(entry => entry.type !== "session" && !stateRecords.isCurrent(entry))?.id ?? null;
    if (manager.persist && manager.sessionFile) stateRecords.selectBranch(manager.sessionFile, manager.getSessionId(), tip, leaf);
    manager.leafId = leaf;
  };
  prototype.branch = function (id) { selectBranch(this, id); };
  prototype.resetLeaf = function () { selectBranch(this, null); };

  const getEntries = prototype.getEntries;
  const getBranch = prototype.getBranch;
  const getEntry = prototype.getEntry;
  prototype.getEntry = function (id) { return currentEntries(this).find(entry => entry.id === id) ?? getEntry.call(this, id); };
  prototype.getEntries = function () { return [...currentEntries(this), ...getEntries.call(this)]; };
  prototype.getBranch = function (...args) {
    const current = currentEntries(this);
    const selection = entry => ["model_change", "thinking_level_change"].includes(entry.type);
    const branch = [...current.filter(entry => !selection(entry)), ...getBranch.apply(this, args)];
    for (const entry of current.filter(selection)) branch.push({ ...entry, parentId: branch.at(-1)?.id ?? null });
    return branch;
  };
  const buildProjection = prototype.buildSessionProjection;
  prototype.buildSessionProjection = function (...args) {
    const projection = buildProjection.apply(this, args);
    const current = currentSessionState.get(this);
    const model = current?.get("piop-selected-model");
    return { ...projection, model: model ? { provider: model.provider, modelId: model.modelId } : null,
      thinkingLevel: current?.get("piop-thinking-level")?.thinkingLevel ?? "off" };
  };

  prototype.getSessionName = function () {
    const name = currentSessionState.get(this)?.get("piop-session-name")?.name;
    return name ? stateRecords.capSessionName(name) || undefined : undefined;
  };

  prototype.appendCustomEntry = function (type, data) {
    const entry = stateRecords.create(type, data, this.leafId);
    this._appendEntry(entry);
    return entry.id;
  };

  prototype._appendEntry = function (entry) {
    sessionStorageState(this);
    if (stateRecords.isCurrent(entry)) {
      entry = { ...entry, parentId: null };
      if (entry.type === "session_info") entry.name = stateRecords.capSessionName(entry.name);
      if (this.persist && this.sessionFile) sessionStorageAppend(this, entry);
      const current = currentSessionState.get(this) ?? new Map();
      current.set(stateRecords.stateKey(entry), entry);
      currentSessionState.set(this, current);
      return;
    }
    persistSessionEntry(this, entry);
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  };

  prototype._rewriteFile = function () {
    sessionStorageState(this);

    if (this.persist && this.sessionFile) sessionStoragePublish(this, [this.fileEntries[0], ...this.getEntries()], false);
  };

  installedStorageClasses.add(SessionManager);
}
