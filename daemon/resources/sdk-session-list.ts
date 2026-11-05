import { createReadStream, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import * as database from "./session-database.ts";
import { sessionName } from "./session-broker/session-names.ts";
import { sessionHeaderMatches } from "./piop-storage/transcript-file.ts";
import { patchMethod, requireMethods } from "./pi-patch.ts";

function rootDirectory(): string {
  return realpathSync(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop"));
}

function managedDirectory(directory: string | undefined, root: string): string | undefined {
  const path = directory ? resolve(directory) : join(root, "sessions");
  let canonical: string;

  try { canonical = realpathSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; canonical = path; }

  const sessions = join(root, "sessions");

  return canonical === sessions || canonical.startsWith(sessions + sep) ? canonical : undefined;
}

function candidates(directory: string, recursive: boolean) {
  return database.sdkSessionListRows(rootDirectory(), directory, recursive).sort((a, b) => basename(b.session_path).localeCompare(basename(a.session_path)));
}

function entry(line: string, path: string, lineNumber: number): any {
  try {
    const record = JSON.parse(line);
    if (!record || typeof record.type !== "string") throw new Error("Invalid record");
    return record;
  } catch { throw new Error(`Damaged chat record at line ${lineNumber}: ${path}`); }
}

function messageText(message: any): string {
  if (message.content?.constructor === String) return message.content;

  return Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join(" ") : "";
}

function collectMessage(state: any, record: any): void {
  state.messageCount++;
  const message = record.message;

  if (!["user", "assistant"].includes(message?.role) || !("content" in message)) return;
  const time = message.timestamp?.constructor === Number ? message.timestamp : Date.parse(record.timestamp);

  if (Number.isFinite(time)) state.activity = Math.max(state.activity, time);
  const text = messageText(message);

  if (!text) return;
  state.messages.push(text);

  if (!state.firstMessage && message.role === "user") state.firstMessage = text;
}

function collectEntry(state: any, record: any): boolean {
  if (!record) return true;

  if (!state.header) {
    if (record.type !== "session" || record.id !== state.id) return false;
    state.header = record;

    return true;
  }

  if (record.type === "message") collectMessage(state, record);

  return true;
}

function summaryValue(row: any, state: any): any {
  const header = state.header;

  if (!header) return undefined;
  const created = new Date(header.timestamp);
  const modified = state.activity > 0 ? new Date(state.activity) : Number.isNaN(created.getTime()) ? statSync(row.session_path).mtime : created;

  return { path: row.session_path, id: header.id, cwd: header.cwd?.constructor === String ? header.cwd : "", name: state.name,
    parentSessionPath: header.parentSession, created, modified, messageCount: state.messageCount,
    firstMessage: state.firstMessage || "(no messages)", allMessagesText: state.messages.join(" ") };
}

async function readSummary(row: any, signal?: AbortSignal): Promise<any> {
  const state = { id: row.session_id, messageCount: 0, firstMessage: "", messages: [] as string[], activity: 0 };
  const input = createReadStream(row.session_path, { signal });
  let pending: Buffer[] = [];
  let lineNumber = 0;

  try {
    for await (const chunk of input) {
      signal?.throwIfAborted();
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) >= 0) {
        pending.push(chunk.subarray(start, end));
        const line = Buffer.concat(pending).toString("utf8");
        pending = []; start = end + 1;
        if (!collectEntry(state, entry(line, row.session_path, ++lineNumber))) return undefined;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    }
    const interruptedBytes = pending.reduce((total, chunk) => total + chunk.length, 0);
    if (interruptedBytes) console.warn(`${row.session_path}: last write was interrupted; ignored ${interruptedBytes} bytes`);
  } finally { input.destroy(); }

  return summaryValue(row, state);
}

function sorted(values: any[]): any[] {
  return values.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function availableSummary(row: any, signal?: AbortSignal): Promise<any> {
  try {
    const value = await readSummary(row, signal);
    return value ? { ...value, name: sessionName(row.session_path, row.session_id) } : undefined;
  }
  catch (error) {
    signal?.throwIfAborted();

    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;

    return undefined;
  }
}

function matchesCwd(value: any, cwd: string | undefined): boolean {
  return !cwd || value.cwd && resolve(value.cwd) === resolve(cwd);
}

function reportProgress(progress: any, loaded: number, total: number, values: any[]): void {
  const publish = loaded === 1 || loaded % 10 === 0 || loaded === total;
  progress?.(loaded, total, publish ? sorted([...values]) : undefined);
}

function recentTime(row: any): bigint | undefined {
  try { return statSync(row.session_path, { bigint: true }).mtimeNs; }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;

    return undefined;
  }
}

function recentSession(directory: string, cwd: string): string | undefined {
  const rows = candidates(directory, false).map(row => ({ row, time: recentTime(row) })).filter((value): value is { row: any; time: bigint } => value.time !== undefined);
  rows.sort((a, b) => a.time === b.time ? 0 : a.time > b.time ? -1 : 1);

  return rows.find(({ row }) => sessionHeaderMatches(row.session_path, row.session_id, cwd))?.row.session_path;
}

function installRecentSession(SessionManager: any): void {
  patchMethod(SessionManager, "continueRecent", (original: any) => function (this: any, cwd: string, sessionDir?: string) {
    const directory = managedDirectory(sessionDir, rootDirectory());

    if (!directory) return original.call(this, cwd, sessionDir);
    const file = recentSession(directory, cwd);

    return file ? this.open(file, directory, cwd) : this.create(cwd, directory);
  });
}

async function list(directory: string, cwd: string | undefined, recursive: boolean, progress?: any, signal?: AbortSignal): Promise<any[]> {
  signal?.throwIfAborted();
  const rows = candidates(directory, recursive);
  const values: any[] = [];
  let loaded = 0;

  for (const row of rows) {
    signal?.throwIfAborted();
    const value = await availableSummary(row, signal);

    if (value && matchesCwd(value, cwd)) values.push(value);
    reportProgress(progress, ++loaded, rows.length, values);
  }

  return sorted(values);
}

export function installSessionLists(SessionManager: any): void {
  requireMethods(SessionManager, ["continueRecent", "list", "listAll", "open", "create"]);
  installRecentSession(SessionManager);

  patchMethod(SessionManager, "list", (originalList: any) => function (this: any, cwd: string, sessionDir: string | undefined, progress?: any, signal?: AbortSignal) {
    const directory = managedDirectory(sessionDir, rootDirectory());

    return directory ? list(directory, cwd, false, progress, signal) : originalList.call(this, cwd, sessionDir, progress, signal);
  });

  patchMethod(SessionManager, "listAll", (originalAll: any) => function (this: any, sessionDirOrProgress: any, progressOrSignal: any, signal?: AbortSignal) {
    const explicit = sessionDirOrProgress?.constructor === String;
    const directory = managedDirectory(explicit ? String(sessionDirOrProgress) : undefined, rootDirectory());

    if (!directory) return originalAll.call(this, sessionDirOrProgress, progressOrSignal, signal);
    const progress = sessionDirOrProgress instanceof Function ? sessionDirOrProgress : progressOrSignal instanceof Function ? progressOrSignal : undefined;
    const abort = explicit || progressOrSignal instanceof Function ? signal : progressOrSignal ?? signal;

    return list(directory, undefined, !explicit, progress, abort);
  });
}
