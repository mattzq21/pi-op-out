import { createReadStream, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import * as database from "./session-database.cjs";
import { sessionName } from "./session-broker/session-names.cjs";
import { sessionHeaderMatches } from "./piop-storage/transcript-file.mjs";
import { patchMethod, requireMethods } from "./pi-patch.cjs";

function rootDirectory() {
  return realpathSync(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop"));
}

function managedDirectory(directory, root) {
  const path = directory ? resolve(directory) : join(root, "sessions");
  let canonical;

  try { canonical = realpathSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; canonical = path; }

  const sessions = join(root, "sessions");

  return canonical === sessions || canonical.startsWith(sessions + sep) ? canonical : undefined;
}

function candidates(db, directory, recursive) {
  const prefix = directory + sep;

  const rows = db.prepare(`SELECT s.session_id, s.session_path FROM sessions s
    WHERE s.archived=0 AND substr(s.session_path, 1, length(?))=?
    AND (? OR instr(substr(s.session_path, length(?) + 1), ?)=0)`)
    .all(prefix, prefix, Number(recursive), prefix, sep);

  return rows.sort((a, b) => basename(b.session_path).localeCompare(basename(a.session_path)));
}

function entry(line, path, lineNumber) {
  try {
    const record = JSON.parse(line);
    if (!record || typeof record.type !== "string") throw new Error("Invalid record");
    return record;
  } catch { throw new Error(`Damaged chat record at line ${lineNumber}: ${path}`); }
}

function messageText(message) {
  if (message.content?.constructor === String) return message.content;

  return Array.isArray(message.content) ? message.content.filter(block => block?.type === "text").map(block => block.text).join(" ") : "";
}

function collectMessage(state, record) {
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

function collectEntry(state, record) {
  if (!record) return true;

  if (!state.header) {
    if (record.type !== "session" || record.id !== state.id) return false;
    state.header = record;

    return true;
  }

  if (record.type === "message") collectMessage(state, record);

  return true;
}

function summaryValue(row, state) {
  const header = state.header;

  if (!header) return undefined;
  const created = new Date(header.timestamp);
  const modified = state.activity > 0 ? new Date(state.activity) : Number.isNaN(created.getTime()) ? statSync(row.session_path).mtime : created;

  return { path: row.session_path, id: header.id, cwd: header.cwd?.constructor === String ? header.cwd : "", name: state.name,
    parentSessionPath: header.parentSession, created, modified, messageCount: state.messageCount,
    firstMessage: state.firstMessage || "(no messages)", allMessagesText: state.messages.join(" ") };
}

async function readSummary(row, signal) {
  const state = { id: row.session_id, messageCount: 0, firstMessage: "", messages: [], activity: 0 };
  const input = createReadStream(row.session_path, { signal });
  let pending = [];
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

function sorted(values) {
  return values.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function availableSummary(db, row, signal) {
  try {
    const value = await readSummary(row, signal);
    return value ? { ...value, name: sessionName(row.session_path, row.session_id, db) } : undefined;
  }
  catch (error) {
    signal?.throwIfAborted();

    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;

    return undefined;
  }
}

function matchesCwd(value, cwd) {
  return !cwd || value.cwd && resolve(value.cwd) === resolve(cwd);
}

function reportProgress(progress, loaded, total, values) {
  const publish = loaded === 1 || loaded % 10 === 0 || loaded === total;
  progress?.(loaded, total, publish ? sorted([...values]) : undefined);
}

function openListDatabase() {
  return database.connection(rootDirectory());
}

function recentTime(row) {
  try { return statSync(row.session_path, { bigint: true }).mtimeNs; }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;

    return undefined;
  }
}

function recentSession(directory, cwd) {
  const db = openListDatabase();
  const rows = candidates(db, directory, false).map(row => ({ row, time: recentTime(row) })).filter(value => value.time !== undefined);
  rows.sort((a, b) => a.time === b.time ? 0 : a.time > b.time ? -1 : 1);

  return rows.find(({ row }) => sessionHeaderMatches(row.session_path, row.session_id, cwd))?.row.session_path;
}

function installRecentSession(SessionManager) {
  patchMethod(SessionManager, "continueRecent", original => function (cwd, sessionDir) {
    const directory = managedDirectory(sessionDir, rootDirectory());

    if (!directory) return original.call(this, cwd, sessionDir);
    const file = recentSession(directory, cwd);

    return file ? this.open(file, directory, cwd) : this.create(cwd, directory);
  });
}

async function list(directory, cwd, recursive, progress, signal) {
  signal?.throwIfAborted();
  const db = openListDatabase();
  const rows = candidates(db, directory, recursive);
  const values = [];
  let loaded = 0;

  for (const row of rows) {
    signal?.throwIfAborted();
    const value = await availableSummary(db, row, signal);

    if (value && matchesCwd(value, cwd)) values.push(value);
    reportProgress(progress, ++loaded, rows.length, values);
  }

  return sorted(values);
}

export function installSessionLists(SessionManager) {
  requireMethods(SessionManager, ["continueRecent", "list", "listAll", "open", "create"]);
  installRecentSession(SessionManager);

  patchMethod(SessionManager, "list", originalList => function (cwd, sessionDir, progress, signal) {
    const directory = managedDirectory(sessionDir, rootDirectory());

    return directory ? list(directory, cwd, false, progress, signal) : originalList.call(this, cwd, sessionDir, progress, signal);
  });

  patchMethod(SessionManager, "listAll", originalAll => function (sessionDirOrProgress, progressOrSignal, signal) {
    const explicit = sessionDirOrProgress?.constructor === String;
    const directory = managedDirectory(explicit ? sessionDirOrProgress : undefined, rootDirectory());

    if (!directory) return originalAll.call(this, sessionDirOrProgress, progressOrSignal, signal);
    const progress = sessionDirOrProgress instanceof Function ? sessionDirOrProgress : progressOrSignal instanceof Function ? progressOrSignal : undefined;
    const abort = explicit || progressOrSignal instanceof Function ? signal : progressOrSignal ?? signal;

    return list(directory, undefined, !explicit, progress, abort);
  });
}
