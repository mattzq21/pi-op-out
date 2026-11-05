import * as stateRecords from "./session-records.cjs";
import { takeSessionId } from "./identities.mjs";
import * as registry from "../session-registry.cjs";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";

import { storageTarget } from "../storage-file.mjs";
import { patchMethod, requireMethods } from "../pi-patch.cjs";
import { readTranscript, sessionHeaderMatches, sessionReferenceRoot } from "./transcript-file.mjs";


const installedStorageClasses = new WeakSet();
const currentSessionState = new WeakMap();

function takeCurrentState(manager, entries) {
  currentSessionState.set(manager, new Map(entries.filter(stateRecords.isCurrent).map(entry => [stateRecords.stateKey(entry), { ...entry, parentId: null }])));
  return stateRecords.history(entries);
}

function currentEntries(manager) { return [...(currentSessionState.get(manager)?.values() ?? [])].sort((a, b) => stateRecords.stateKey(a).localeCompare(stateRecords.stateKey(b))); }

const failedSessionStorage = new WeakSet();

const sessionStorageFiles = new WeakMap();


// The daemon writes all saved chats. Pi asks it through these calls; see transcript-writes.mjs.
const installedWrites = new WeakMap();

function writesFor(prototype) {
  for (let current = prototype; current; current = Object.getPrototypeOf(current)) {
    const found = installedWrites.get(current);
    if (found) return found;
  }
  throw new Error("Session storage is not installed");
}

function writes(manager) { return writesFor(Object.getPrototypeOf(manager)); }

// Reads a saved transcript, after any end of a line that a write did not finish has been dropped.
function repairedTranscript(path, transcriptWrites) {
  const read = readTranscript(path, { strict: true });
  if (!read.partial) return read;
  const identity = transcriptWrites.repair({ path, identity: read.identity, end: read.end });
  console.warn(`${path}: last write was interrupted; dropped ${read.partial} bytes`);
  return { ...read, identity, partial: 0 };
}

function openedSessionEntries(path, manager) {
  const { entries, identity } = repairedTranscript(path, writes(manager));
  sessionStorageFiles.set(manager, { path, identity });
  return entries;
}

function bindNewSession(manager) {
  writes(manager).bind({ sessionId: manager.getSessionId(), path: manager.sessionFile });
}

function installSessionCreation(SessionManager) {
  const prototype = SessionManager.prototype;

  patchMethod(SessionManager, "open", open => function (path, ...args) {
    if (storageFs.existsSync(path)) repairedTranscript(path, writesFor(this.prototype));
    return open.call(this, path, ...args);
  });

  patchMethod(prototype, "_setSessionFile", setFile => function (path, entries) {
    if (this.persist && storageFs.existsSync(path)) entries = openedSessionEntries(path, this);
    return setFile.call(this, path, entries);
  });

  patchMethod(prototype, "newSession", create => function (options) {
    if (!this.persist) { currentSessionState.set(this, new Map()); return create.call(this, options); }
    const id = options?.id ?? takeSessionId();
    currentSessionState.set(this, new Map());
    const result = create.call(this, { ...options, id });
    bindNewSession(this);
    sessionStoragePublish(this, this.fileEntries, true);
    this.flushed = true;

    return result;
  });

  patchMethod(prototype, "_loadEntries", load => function (entries, options) {
    if (this.persist && this.sessionFile) entries = openedSessionEntries(this.sessionFile, this);
    const header = entries.find(entry => entry.type === "session");

    if (this.persist && header) {
      registry.requireSession(sessionReferenceRoot(), header.id, this.sessionFile);
    }

    return load.call(this, takeCurrentState(this, entries), options);
  });

  patchMethod(SessionManager, "forkFrom", () => function (sourcePath, targetCwd, sessionDir, options) {
    const source = this.open(sourcePath);
    const session = this.create(targetCwd, sessionDir, { ...options, parentSession: sourcePath });
    session.fileEntries = [session.fileEntries[0], ...structuredClone(source.getEntries())];
    session._buildIndex();
    writes(session).copyGoal({ source: sourcePath, target: session.sessionFile, sessionId: session.getSessionId() });
    sessionStoragePublish(session, session.fileEntries, false);
    session.fileEntries = takeCurrentState(session, session.fileEntries);
    session._buildIndex();
    session.flushed = true;
    if (source.getLeafId() === null) session.resetLeaf();
    else session.branch(source.getLeafId());

    return session;
  });

  installSessionBranching(prototype);
}

function installSessionBranching(prototype) {
  patchMethod(prototype, "createBranchedSession", branch => function (...args) {
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
    writes(this).copyGoal({ source: parent, target: this.sessionFile, sessionId: id });
    sessionStoragePublish(this, this.fileEntries, true);
    this.fileEntries = takeCurrentState(this, this.fileEntries);
    this._buildIndex();
    this.flushed = true;

    return this.sessionFile;
  });
}

function sessionStorageState(manager) {
  if (failedSessionStorage.has(manager)) throw new Error("Session storage could not be rolled back safely. Reopen the conversation before continuing.");

  if (!Array.isArray(manager.fileEntries) || !(manager.byId instanceof Map)) throw new Error("This Pi SDK changed its session storage format. Update Piop before continuing.");
}

function sessionStoragePublish(manager, entries, exclusive) {
  const path = manager.sessionFile;
  let identity;
  try { identity = writes(manager).publish({ path, entries, exclusive }); }
  catch (error) { if (error.damaged) failedSessionStorage.add(manager); throw error; }
  sessionStorageFiles.set(manager, { path, identity });
}

function sessionStorageAppend(manager, entry) {
  const path = manager.sessionFile;
  const expected = sessionStorageFiles.get(manager);
  const after = entry.type === "custom" || stateRecords.isCurrent(entry) ? manager.fileEntries.findLast(item => item.type !== "session" && item.type !== "custom")?.id ?? null : null;
  let identity;
  try {
    identity = writes(manager).append({
      path, sessionId: manager.getSessionId(), entry, after,
      expected: expected?.path === path ? expected.identity : null,
    });
  } catch (error) { if (error.damaged) failedSessionStorage.add(manager); throw error; }
  if (identity) sessionStorageFiles.set(manager, { path, identity });
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

function installSessionLookup(SessionManager) {
  patchMethod(SessionManager, "findById", find => function (cwd, id, sessionDir) {
    const root = storageTarget(sessionReferenceRoot());
    const directory = storageTarget(sessionDir ? storagePath.resolve(sessionDir) : storagePath.join(root, "sessions"));

    const sessions = storagePath.join(root, "sessions");

    if (directory !== sessions && !directory.startsWith(sessions + storagePath.sep)) return find.call(this, cwd, id, sessionDir);
    const file = registeredSessionPath(id, directory);

    return file && sessionHeaderMatches(file, id, cwd) ? file : undefined;
  });
}

// `transcriptWrites` runs each write: the daemon's storage channel in Pi, or local writes in tests.
export function installSessionStorage(SessionManager, transcriptWrites) {
  if (installedStorageClasses.has(SessionManager)) return;
  const prototype = SessionManager.prototype;
  requireMethods(prototype, ["newSession", "_loadEntries", "_setSessionFile", "createBranchedSession", "_appendEntry", "_persist", "_rewriteFile", "_hasConversation",
    "_buildIndex", "branch", "resetLeaf", "getEntry", "getEntries", "getBranch", "buildSessionProjection", "appendCustomEntry"]);
  requireMethods(SessionManager, ["findById", "open", "forkFrom", "create"]);
  installSessionLookup(SessionManager);
  installSessionCreation(SessionManager);

  if (["publish", "append", "repair", "bind", "selectBranch", "copyGoal"].some(name => typeof transcriptWrites?.[name] !== "function")) throw new Error("Session storage needs its transcript writes");
  installedWrites.set(prototype, transcriptWrites);

  patchMethod(prototype, "_buildIndex", buildIndex => function () {
    buildIndex.call(this);
    if (!this.persist || !this.sessionFile) return;
    const tip = this.fileEntries.findLast(entry => entry.type !== "session" && !stateRecords.isCurrent(entry))?.id ?? null;
    const leaf = stateRecords.selectedLeaf(this.sessionFile, this.getSessionId(), tip);
    if (leaf !== null && !this.byId.has(leaf)) throw new Error("The saved branch points to a missing entry");
    this.leafId = leaf;
  });

  const selectBranch = (manager, leaf) => {
    sessionStorageState(manager);
    if (leaf !== null && !manager.byId.has(leaf)) throw new Error(`Entry ${leaf} not found`);
    const tip = manager.fileEntries.findLast(entry => entry.type !== "session" && !stateRecords.isCurrent(entry))?.id ?? null;
    if (manager.persist && manager.sessionFile) writes(manager).selectBranch({ path: manager.sessionFile, sessionId: manager.getSessionId(), tip, leaf });
    manager.leafId = leaf;
  };
  patchMethod(prototype, "branch", () => function (id) { selectBranch(this, id); });
  patchMethod(prototype, "resetLeaf", () => function () { selectBranch(this, null); });

  patchMethod(prototype, "getEntry", getEntry => function (id) { return currentEntries(this).find(entry => entry.id === id) ?? getEntry.call(this, id); });
  patchMethod(prototype, "getEntries", getEntries => function () { return [...currentEntries(this), ...getEntries.call(this)]; });
  patchMethod(prototype, "getBranch", getBranch => function (...args) {
    const current = currentEntries(this);
    const selection = entry => ["model_change", "thinking_level_change"].includes(entry.type);
    const branch = [...current.filter(entry => !selection(entry)), ...getBranch.apply(this, args)];
    for (const entry of current.filter(selection)) branch.push({ ...entry, parentId: branch.at(-1)?.id ?? null });
    return branch;
  });
  patchMethod(prototype, "buildSessionProjection", buildProjection => function (...args) {
    const projection = buildProjection.apply(this, args);
    const current = currentSessionState.get(this);
    const model = current?.get("piop-selected-model");
    return { ...projection, model: model ? { provider: model.provider, modelId: model.modelId } : null,
      thinkingLevel: current?.get("piop-thinking-level")?.thinkingLevel ?? "off" };
  });

  patchMethod(prototype, "appendCustomEntry", () => function (type, data) {
    const entry = stateRecords.create(type, data, this.leafId);
    this._appendEntry(entry);
    return entry.id;
  });

  patchMethod(prototype, "_appendEntry", () => function (entry) {
    sessionStorageState(this);
    if (stateRecords.isName(entry)) throw new Error("Pi sessions have no name: the Piop session broker owns chat names");
    if (stateRecords.isCurrent(entry)) {
      entry = { ...entry, parentId: null };
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
  });

  patchMethod(prototype, "_rewriteFile", () => function () {
    sessionStorageState(this);

    if (this.persist && this.sessionFile) sessionStoragePublish(this, [this.fileEntries[0], ...this.getEntries()], false);
  });

  installedStorageClasses.add(SessionManager);
}
