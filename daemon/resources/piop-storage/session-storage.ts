import * as stateRecords from './session-records.ts';
import { takeSessionId } from './identities.ts';
import { lookup } from '../session-database/index.ts';
import * as storageFs from "node:fs";
import * as storagePath from "node:path";

import { storageTarget } from "./storage-file.ts";
import { patchMethod, requireMethods } from "../pi/index.ts";
import { readTranscript, sessionHeaderMatches, sessionReferenceRoot } from "./transcript-file.ts";
import type { FileEntry, SessionEntry, SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

type SessionManagerClass = typeof PiSessionManager;
type TranscriptWrites = Record<"publish" | "append" | "selectBranch" | "copyGoal", (request: unknown) => unknown>;
// A setting entry of a chat (selected model, thinking level, plugin state). Only its latest value counts.
type CurrentEntry = { type: string; id: string; parentId: null; [field: string]: unknown };

// The fields that Pi's SessionManager keeps private, and that the storage reads and changes.
interface SessionInternals {
  persist: boolean;
  flushed: boolean;
  sessionFile: string | undefined;
  fileEntries: FileEntry[];
  byId: Map<string, SessionEntry>;
  leafId: string | null;
  getSessionId(): string;
  _hasConversation(): boolean;
}

const installedStorageClasses = new WeakSet<SessionManagerClass>();
const currentSessionState = new WeakMap<object, Map<string, CurrentEntry>>();

function takeCurrentState(manager: object, entries: FileEntry[]) {
  currentSessionState.set(manager, new Map(entries.filter(stateRecords.isCurrent).map(entry => [stateRecords.stateKey(entry), { ...entry, parentId: null }])));
  return stateRecords.history(entries);
}

function currentEntries(manager: object): CurrentEntry[] { return [...(currentSessionState.get(manager)?.values() ?? [])].sort((a, b) => stateRecords.stateKey(a).localeCompare(stateRecords.stateKey(b))); }

const failedSessionStorage = new WeakSet<object>();


// The daemon writes all saved chats. Pi asks it through these calls; see transcript-writes.ts.
const installedWrites = new WeakMap<object, TranscriptWrites>();

function writesFor(prototype: object | null): TranscriptWrites {
  for (let current = prototype; current; current = Object.getPrototypeOf(current)) {
    const found = installedWrites.get(current);
    if (found) return found;
  }
  throw new Error("Session storage is not installed");
}

function writes(manager: object): TranscriptWrites { return writesFor(Object.getPrototypeOf(manager)); }

function installSessionCreation(SessionManager: SessionManagerClass): void {
  const prototype = SessionManager.prototype;

  patchMethod(prototype, "_setSessionFile", setFile => function (this: any, path, entries) {
    if (this.persist && storageFs.existsSync(path)) entries = readTranscript(path).entries;
    return setFile.call(this, path, entries);
  });

  patchMethod(prototype, "newSession", create => function (this: any, options) {
    if (!this.persist) { currentSessionState.set(this, new Map()); return create.call(this, options); }
    const id = options?.id ?? takeSessionId();
    currentSessionState.set(this, new Map());
    const result = create.call(this, { ...options, id });
    sessionStoragePublish(this, this.fileEntries, true);
    this.flushed = true;

    return result;
  });

  patchMethod(prototype, "_loadEntries", load => function (this: any, entries, options) {
    if (this.persist && this.sessionFile) entries = readTranscript(this.sessionFile).entries;
    return load.call(this, takeCurrentState(this, entries), options);
  });

  patchMethod(SessionManager, "forkFrom", () => function (this: any, sourcePath, targetCwd, sessionDir, options) {
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

function installSessionBranching(prototype: PiSessionManager): void {
  patchMethod(prototype, "createBranchedSession", branch => function (this: any, ...args) {
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
    sessionStoragePublish(this, this.fileEntries, true);
    writes(this).copyGoal({ source: parent, target: this.sessionFile, sessionId: id });
    this.fileEntries = takeCurrentState(this, this.fileEntries);
    this._buildIndex();
    this.flushed = true;

    return this.sessionFile;
  });
}

function sessionStorageState(manager: SessionInternals): void {
  if (failedSessionStorage.has(manager)) throw new Error("Session storage could not be rolled back safely. Reopen the conversation before continuing.");

  if (!Array.isArray(manager.fileEntries) || !(manager.byId instanceof Map)) throw new Error("This Pi SDK changed its session storage format. Update Piop before continuing.");
}

// `exclusive` creates the transcript, and saves its path for its reserved ID.
function sessionStoragePublish(manager: SessionInternals, entries: FileEntry[], exclusive: boolean): void {
  try { writes(manager).publish({ path: manager.sessionFile, entries, exclusive }); }
  catch (error) { if (error.damaged) failedSessionStorage.add(manager); throw error; }
}

function sessionStorageAppend(manager: SessionInternals, entry: FileEntry | CurrentEntry): void {
  const after = stateRecords.isRecord(entry) || stateRecords.isCurrent(entry) ? manager.fileEntries.findLast(item => item.type !== "session" && !stateRecords.isRecord(item))?.id ?? null : null;
  try { writes(manager).append({ path: manager.sessionFile, sessionId: manager.getSessionId(), entry, after }); }
  catch (error) { if (error.damaged) failedSessionStorage.add(manager); throw error; }
}

function persistSessionEntry(manager: SessionInternals, entry: SessionEntry): void {
  if (!manager.persist || !manager.sessionFile) return;

  if (manager.flushed) { sessionStorageAppend(manager, entry);

  return; }

  const conversation = entry.type === "message" && ["user", "assistant"].includes(entry.message.role);

  if (!conversation && !manager._hasConversation()) return;
  sessionStoragePublish(manager, [...manager.fileEntries, entry], true);
  manager.flushed = true;
}

function registeredSessionPath(id: string, directory: string): string | undefined {
  const file = lookup(sessionReferenceRoot(), id);
  return file && storageTarget(storagePath.dirname(file)) === directory ? file : undefined;
}

function installSessionLookup(SessionManager: SessionManagerClass): void {
  patchMethod(SessionManager, "findById", find => function (this: any, cwd, id, sessionDir) {
    const root = storageTarget(sessionReferenceRoot());
    const directory = storageTarget(sessionDir ? storagePath.resolve(sessionDir) : storagePath.join(root, "sessions"));

    const sessions = storagePath.join(root, "sessions");

    if (directory !== sessions && !directory.startsWith(sessions + storagePath.sep)) return find.call(this, cwd, id, sessionDir);
    const file = registeredSessionPath(id, directory);

    return file && sessionHeaderMatches(file, id, cwd) ? file : undefined;
  });
}

// `transcriptWrites` runs each write: the daemon's storage channel in Pi, or local writes in tests.
export function installSessionStorage(SessionManager: SessionManagerClass, transcriptWrites: TranscriptWrites): void {
  if (installedStorageClasses.has(SessionManager)) return;
  const prototype = SessionManager.prototype;
  requireMethods(prototype, ["newSession", "_loadEntries", "_setSessionFile", "createBranchedSession", "_appendEntry", "_persist", "_rewriteFile", "_hasConversation",
    "_buildIndex", "branch", "resetLeaf", "getEntry", "getEntries", "getBranch", "buildSessionProjection", "appendCustomEntry"]);
  requireMethods(SessionManager, ["findById", "open", "forkFrom", "create"]);
  installSessionLookup(SessionManager);
  installSessionCreation(SessionManager);

  if ((["publish", "append", "selectBranch", "copyGoal"] as const).some(name => typeof transcriptWrites?.[name] !== "function")) throw new Error("Session storage needs its transcript writes");
  installedWrites.set(prototype, transcriptWrites);

  patchMethod(prototype, "_buildIndex", buildIndex => function (this: any) {
    buildIndex.call(this);
    if (!this.persist || !this.sessionFile) return;
    const tip = this.fileEntries.findLast((entry: FileEntry) => entry.type !== "session" && !stateRecords.isCurrent(entry))?.id ?? null;
    const leaf = stateRecords.selectedLeaf(this.sessionFile, this.getSessionId(), tip);
    if (leaf !== null && !this.byId.has(leaf)) throw new Error("The saved branch points to a missing entry");
    this.leafId = leaf;
  });

  const selectBranch = (manager: SessionInternals, leaf: string | null) => {
    sessionStorageState(manager);
    if (leaf !== null && !manager.byId.has(leaf)) throw new Error(`Entry ${leaf} not found`);
    const tip = manager.fileEntries.findLast(entry => entry.type !== "session" && !stateRecords.isCurrent(entry))?.id ?? null;
    if (manager.persist && manager.sessionFile) writes(manager).selectBranch({ path: manager.sessionFile, sessionId: manager.getSessionId(), tip, leaf });
    manager.leafId = leaf;
  };
  patchMethod(prototype, "branch", () => function (this: any, id) { selectBranch(this, id); });
  patchMethod(prototype, "resetLeaf", () => function (this: any) { selectBranch(this, null); });

  patchMethod(prototype, "getEntry", getEntry => function (this: any, id) { return currentEntries(this).find(entry => entry.id === id) ?? getEntry.call(this, id); });
  patchMethod(prototype, "getEntries", getEntries => function (this: any) { return [...currentEntries(this), ...getEntries.call(this)]; });
  patchMethod(prototype, "getBranch", getBranch => function (this: any, ...args) {
    const current = currentEntries(this);
    const selection = (entry: CurrentEntry) => ["model_change", "thinking_level_change"].includes(entry.type);
    const branch = [...current.filter(entry => !selection(entry)), ...getBranch.apply(this, args)];
    for (const entry of current.filter(selection)) branch.push({ ...entry, parentId: branch.at(-1)?.id ?? null });
    return branch;
  });
  patchMethod(prototype, "buildSessionProjection", buildProjection => function (this: any, ...args) {
    const projection = buildProjection.apply(this, args);
    const current = currentSessionState.get(this);
    const model = current?.get("piop-selected-model");
    return { ...projection, model: model ? { provider: model.provider, modelId: model.modelId } : null,
      thinkingLevel: current?.get("piop-thinking-level")?.thinkingLevel ?? "off" };
  });

  patchMethod(prototype, "appendCustomEntry", () => function (this: any, type, data) {
    const entry = stateRecords.create(type, data, this.leafId);
    this._appendEntry(entry);
    return entry.id;
  });

  patchMethod(prototype, "_appendEntry", () => function (this: any, entry) {
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

  patchMethod(prototype, "_rewriteFile", () => function (this: any) {
    sessionStorageState(this);

    if (this.persist && this.sessionFile) sessionStoragePublish(this, [this.fileEntries[0], ...this.getEntries()], false);
  });

  installedStorageClasses.add(SessionManager);
}
