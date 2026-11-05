import * as stateRecords from "./session-records.ts";
import * as receipts from "./mailbox-receipts.ts";
import { copy as copyGoalRecord } from "./goals.ts";
import * as database from "../session-database.ts";
import { storagePublish } from "../storage-file.ts";
import { sessionReferenceRoot } from "./transcript-file.ts";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";

// The chat transcript changes that Pi asks for. Only the daemon runs them: Pi sends each one through its storage channel.
// Each change first moves the revision of its chat, so a cache made from the old transcript is not used again.
// An error with `damaged` set means the transcript may not match Pi's copy any more.

function damaged(error: unknown): Error {
  const failure: Error & { damaged?: boolean } = error instanceof Error ? error : new Error(String(error));
  failure.damaged = true;
  return failure;
}

function transcriptPath(value: unknown): string {
  if (typeof value !== "string" || !storagePath.isAbsolute(value) || !value.endsWith(".jsonl") || value.includes("\0")) throw new Error("Invalid transcript path");
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function entry(value: unknown): any {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as any).type !== "string") throw new Error("Invalid transcript entry");
  return value;
}

function header(entries: any[]): any {
  if (!Array.isArray(entries) || !entries.length) throw new Error("Invalid transcript entries");
  entries.forEach(entry);
  const first = entries[0];
  if (first.type !== "session" || typeof first.id !== "string" || !first.id) throw new Error("Cannot save a session without its identity");
  return first;
}

function storageRootOf(path: string): string { return database.storageRoot(path); }

function temporaryPath(path: string): string {
  const directory = path.slice(0, -6) + ".snapshots";
  storageFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return storagePath.join(directory, "sdk-session.pending");
}

// Saves the whole transcript. `exclusive` creates it at the path that its reserved ID gets; otherwise it replaces the saved one.
export function publish(_root: string, request: any): null {
  const path = transcriptPath(request?.path);
  const entries = request.entries;
  const { id } = header(entries);
  const root = storageRootOf(path);
  database.transaction(root, "IMMEDIATE", () => {
    if (request.exclusive === true) database.bind(root, id, path);
    stateRecords.save(path, entries);
  });
  try { storagePublish(path, temporaryPath(path), stateRecords.stored(entries).map(item => JSON.stringify(item) + "\n").join(""), request.exclusive === true); }
  catch (error) { throw storageFs.existsSync(path) ? damaged(error) : error; }
  try { database.transaction(root, "IMMEDIATE", () => receipts.replace(root, id, entries)); }
  catch (error) { throw damaged(error); }
  return null;
}

function appendLine(path: string, item: any): void {
  const line = Buffer.from(JSON.stringify(item) + "\n", "utf8");
  const descriptor = storageFs.openSync(path, storageFs.constants.O_WRONLY | storageFs.constants.O_APPEND);

  try {
    if (storageFs.writeSync(descriptor, line) !== line.length) throw new Error(`Session append was incomplete: ${path}`);
    storageFs.fsyncSync(descriptor);
  } catch (error) { throw damaged(error); }
  finally { storageFs.closeSync(descriptor); }
}

// Adds one entry. Settings and extension records go to the database; the rest go to the end of the file.
export function append(_root: string, request: any): null {
  const path = transcriptPath(request?.path);
  const sessionId = text(request.sessionId, "session ID");
  const item = entry(request.entry);
  if (stateRecords.isRecord(item) || stateRecords.isCurrent(item)) {
    if (request.after !== null && typeof request.after !== "string") throw new Error("Invalid record position");
    stateRecords.append(path, sessionId, request.after, item);
    return null;
  }
  const root = storageRootOf(path);
  database.revise(root, sessionId);
  appendLine(path, item);
  try { receipts.add(root, sessionId, item); }
  catch (error) { throw damaged(error); }
  return null;
}

// Drops the end of a last line that a write did not finish: the file keeps its first `end` bytes.
export function repair(_root: string, request: any): null {
  const path = transcriptPath(request?.path);
  if (!Number.isSafeInteger(request.end) || request.end < 0) throw new Error("Invalid transcript end");
  database.revisePath(storageRootOf(path), path);
  const descriptor = storageFs.openSync(path, storageFs.constants.O_RDWR);

  try {
    if (request.end > storageFs.fstatSync(descriptor).size) throw new Error(`The saved session is shorter than expected: ${path}`);
    storageFs.ftruncateSync(descriptor, request.end);
    storageFs.fsyncSync(descriptor);
    return null;
  } finally { storageFs.closeSync(descriptor); }
}

export function selectBranch(_root: string, request: any): null {
  const leaf = request?.leaf;
  const tip = request?.tip;
  if ((leaf !== null && typeof leaf !== "string") || (tip !== null && typeof tip !== "string")) throw new Error("Invalid branch selection");
  stateRecords.selectBranch(transcriptPath(request.path), text(request.sessionId, "session ID"), tip, leaf);
  return null;
}

export function copyGoal(_root: string, request: any): null {
  copyGoalRecord(transcriptPath(request?.source), transcriptPath(request.target), text(request.sessionId, "session ID"));
  return null;
}

export const OPERATIONS = { publish, append, repair, selectBranch, copyGoal };

// Runs the operations in this process, on the storage that HOME and PIOP_STORAGE_DIRECTORY name at each call.
// Only tests and fixtures that stand in for the daemon use it.
export function localTranscriptWrites() {
  return Object.fromEntries(Object.entries(OPERATIONS).map(([name, operation]) => [name, (request: any) => structuredClone(operation(sessionReferenceRoot(), structuredClone(request)))]));
}
