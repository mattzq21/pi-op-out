import * as stateRecords from './session-records.ts';
import { copy as copyGoalRecord } from './goals.ts';
import { acquireReferencePublicationLock } from './reference-publication-lock.ts';
import * as registry from '../session-registry.ts';
import * as references from '../transcript-references.ts';
import { storagePublish } from '../storage-file.ts';
import { fileIdentity, managedGoalReferences, readTranscript, sameFile, sessionReferenceRoot, validateNewGoalReferences, validateSessionReferencePublication } from './transcript-file.ts';
import * as storageFs from "node:fs";
import * as storagePath from "node:path";

// The chat transcript changes that Pi asks for. Only the daemon runs them: Pi sends each one through its storage channel.
// `publish` and `append` need the shared reference publication lock; `PUBLICATION_LOCKED` names them.
// An error with `damaged` set means the transcript may not match Pi's copy any more.

export const PUBLICATION_LOCKED = new Set(["publish", "append"]);

// The changes that take the goal asset lock first.
export const GOAL_ASSETS_LOCKED = new Set(["copyGoal"]);

function damaged(error) {
  const failure: Error & { damaged?: boolean } = error instanceof Error ? error : new Error(String(error));
  failure.damaged = true;
  return failure;
}

function transcriptPath(value) {
  if (typeof value !== "string" || !storagePath.isAbsolute(value) || !value.endsWith(".jsonl") || value.includes("\0")) throw new Error("Invalid transcript path");
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function entry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") throw new Error("Invalid transcript entry");
  return value;
}

function header(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("Invalid transcript entries");
  entries.forEach(entry);
  const first = entries[0];
  if (first.type !== "session" || typeof first.id !== "string" || !first.id) throw new Error("Cannot save a session without its identity");
  return first;
}

function registerManaged(root, path, sessionId, saved) {
  const area = storagePath.relative(root, storagePath.resolve(path)).split(storagePath.sep)[0];
  if (["sessions", "archived"].includes(area)) registry.recordTranscript(root, sessionId, storagePath.resolve(path), saved);
}

function temporaryPath(path) {
  const directory = path.slice(0, -6) + ".snapshots";
  storageFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = storageFs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Session storage must be a directory");
  return storagePath.join(directory, "sdk-session.pending");
}

function finish(root, path, sessionId, record) {
  try {
    registerManaged(root, path, sessionId, true);
    record();
  } catch (error) { throw damaged(error); }
}

// Saves the whole transcript. `exclusive` creates it; otherwise it replaces the saved one.
export function publish(root, request) {
  const path = transcriptPath(request?.path);
  const entries = request.entries;
  const { id } = header(entries);
  const exclusive = request.exclusive === true;
  registry.registerExternalTranscript(root, path, id);
  registerManaged(root, path, id, false);
  validateSessionReferencePublication(entries, exclusive ? undefined : readTranscript(path).entries, root);
  stateRecords.save(path, entries);
  try { storagePublish(path, temporaryPath(path), stateRecords.stored(entries).map(item => JSON.stringify(item) + "\n").join(""), exclusive); }
  catch (error) { throw storageFs.existsSync(path) ? damaged(error) : error; }
  const saved = fileIdentity(storageFs.lstatSync(path, { bigint: true }));
  finish(root, path, id, () => references.publish(root, path, entries));
  return saved;
}

function appendLine(path, item, expected) {
  try {
    const original = storageFs.lstatSync(path, { bigint: true });
    if (!original.isFile() || original.size === 0n || !sameFile(fileIdentity(original), expected)) throw new Error("The saved session changed unexpectedly. Reopen the conversation before continuing.");
    const line = Buffer.from(JSON.stringify(item) + "\n", "utf8");
    const descriptor = storageFs.openSync(path, storageFs.constants.O_WRONLY | storageFs.constants.O_APPEND | storageFs.constants.O_NOFOLLOW);

    try {
      const opened = storageFs.fstatSync(descriptor, { bigint: true });
      if (!sameFile(fileIdentity(opened), expected)) throw new Error("The saved session changed unexpectedly. Reopen the conversation before continuing.");
      if (storageFs.writeSync(descriptor, line) !== line.length) throw new Error(`Session append was incomplete: ${path}`);
      storageFs.fsyncSync(descriptor);
      const saved = storageFs.fstatSync(descriptor, { bigint: true });
      const published = storageFs.lstatSync(path, { bigint: true });
      if (saved.size !== original.size + BigInt(line.length) || published.dev !== saved.dev || published.ino !== saved.ino || published.size !== saved.size) throw new Error(`The saved session changed during append: ${path}`);
      return { before: original, saved: fileIdentity(saved) };
    } finally { storageFs.closeSync(descriptor); }
  } catch (error) { throw damaged(error); }
}

// Adds one entry. Settings and extension records go to the database; the rest go to the end of the file,
// which must still be the file that Pi saved last (`expected`). `previous` lists the goal folders that the transcript already names.
export function append(root, request) {
  const path = transcriptPath(request?.path);
  const sessionId = text(request.sessionId, "session ID");
  const item = entry(request.entry);
  if (!Array.isArray(request.previous) || request.previous.some(value => typeof value !== "string")) throw new Error("Invalid saved goal references");
  registry.registerExternalTranscript(root, path, sessionId);
  registerManaged(root, path, sessionId, false);
  validateNewGoalReferences(managedGoalReferences([item], root), request.previous, root);
  if (item.type === "custom" || stateRecords.isCurrent(item)) {
    if (request.after !== null && typeof request.after !== "string") throw new Error("Invalid record position");
    stateRecords.append(path, sessionId, request.after, item);
    const before = storageFs.lstatSync(path, { bigint: true });
    finish(root, path, sessionId, () => references.append(root, path, item, before));
    return null;
  }
  const { before, saved } = appendLine(path, item, request.expected);
  finish(root, path, sessionId, () => references.append(root, path, item, before));
  return saved;
}

// Drops the end of a last line that a write did not finish, if the file is still the one that Pi read.
export function repair(_root, request) {
  const path = transcriptPath(request?.path);
  if (!Number.isSafeInteger(request.end) || request.end < 0) throw new Error("Invalid transcript end");
  const descriptor = storageFs.openSync(path, storageFs.constants.O_RDWR | storageFs.constants.O_NOFOLLOW);

  try {
    const current = storageFs.fstatSync(descriptor, { bigint: true });
    const named = storageFs.lstatSync(path, { bigint: true });
    if (!sameFile(fileIdentity(current), request.identity) || named.dev !== current.dev || named.ino !== current.ino || BigInt(request.end) > current.size) throw new Error(`The saved session changed unexpectedly: ${path}`);
    storageFs.ftruncateSync(descriptor, request.end);
    storageFs.fsyncSync(descriptor);
    return fileIdentity(storageFs.fstatSync(descriptor, { bigint: true }));
  } finally { storageFs.closeSync(descriptor); }
}

export function bind(root, request) {
  registry.bindSession(root, text(request?.sessionId, "session ID"), transcriptPath(request.path));
  return null;
}

export function selectBranch(_root, request) {
  const leaf = request?.leaf;
  const tip = request?.tip;
  if ((leaf !== null && typeof leaf !== "string") || (tip !== null && typeof tip !== "string")) throw new Error("Invalid branch selection");
  stateRecords.selectBranch(transcriptPath(request.path), text(request.sessionId, "session ID"), tip, leaf);
  return null;
}

export function copyGoal(_root, request) {
  copyGoalRecord(transcriptPath(request?.source), transcriptPath(request.target), text(request.sessionId, "session ID"));
  return null;
}

export const OPERATIONS = { publish, append, repair, bind, selectBranch, copyGoal };

// Runs the operations in this process, on the storage that HOME and PIOP_STORAGE_DIRECTORY name at each call.
// Only tests and fixtures that stand in for the daemon use it.
export function localTranscriptWrites() {
  return Object.fromEntries(Object.entries(OPERATIONS).map(([name, operation]) => [name, request => {
    const root = sessionReferenceRoot();
    const release = PUBLICATION_LOCKED.has(name) ? acquireReferencePublicationLock(root, true) : undefined;
    try { return structuredClone(operation(root, structuredClone(request))); }
    finally { release?.(); }
  }]));
}
