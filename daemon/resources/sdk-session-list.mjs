import { createReadStream, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import * as database from "./session-database.cjs";
import * as stateRecords from "./piop-storage/session-records.cjs";
import { sessionHeaderMatches } from "./piop-storage/session-storage.mjs";

const cached = new Map();

function rootDirectory() {
  return realpathSync(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop"));
}

function managedDirectory(directory, root) {
  const path = directory ? resolve(directory) : join(root, "sessions");
  let canonical;

  try { canonical = realpathSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; canonical = path; }

  return ["sessions", "archived"].some(area => canonical === join(root, area) || canonical.startsWith(join(root, area) + sep)) ? canonical : undefined;
}

function candidates(db, directory, recursive) {
  const prefix = directory + sep;

  const rows = db.prepare(`SELECT s.session_id, s.session_path, m.modified_ns, m.size, c.fingerprint, c.body
    FROM sessions s LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path
    LEFT JOIN sdk_session_summaries c ON c.session_id=s.session_id AND c.session_path=s.session_path
    WHERE substr(s.session_path, 1, length(?))=?
    AND (? OR instr(substr(s.session_path, length(?) + 1), ?)=0)`)
    .all(prefix, prefix, Number(recursive), prefix, sep);

  return rows.sort((a, b) => basename(b.session_path).localeCompare(basename(a.session_path)));
}

function fingerprint(row) {
  if (row.modified_ns !== null) return `${row.modified_ns}:${row.size}`;
  const stat = statSync(row.session_path, { bigint: true });

  return `${stat.mtimeNs}:${stat.size}`;
}

function decode(row) {
  let value;

  try { value = JSON.parse(row.body); }
  catch { return; }

  if (!validSummary(value, row)) return;

  return { ...value, created: new Date(value.created ?? NaN), modified: new Date(value.modified ?? NaN) };
}

function validSummary(value, row) {
  return value?.id === row.session_id && value?.path === row.session_path
    && [value.cwd, value.firstMessage, value.allMessagesText].every(item => item?.constructor === String)
    && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0;
}

function savedSummary(row, stamp) {
  return row.fingerprint === stamp && row.body ? decode(row) : undefined;
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

async function summary(db, row, signal) {
  const stamp = fingerprint(row);
  const previous = cached.get(row.session_path);

  if (previous?.stamp === stamp && previous.id === row.session_id) return structuredClone(previous.value);
  const stored = savedSummary(row, stamp);
  const value = stored ?? await readSummary(row, signal);

  if (!value) return undefined;
  const stat = stored ? undefined : statSync(row.session_path, { bigint: true });

  if (stat && stamp !== `${stat.mtimeNs}:${stat.size}`) return value;

  if (!stored) persistSummary(db, row, stamp, value);
  remember(row, stamp, value);

  return structuredClone(value);
}

function persistSummary(db, row, stamp, value) {
  db.prepare(`INSERT INTO sdk_session_summaries SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, fingerprint=excluded.fingerprint, body=excluded.body`)
    .run(stamp, JSON.stringify(value), row.session_id, row.session_path);
}

function remember(row, stamp, value) {
  cached.set(row.session_path, { stamp, id: row.session_id, value });

  if (cached.size > 500) cached.delete(cached.keys().next().value);
}

function sorted(values) {
  return values.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function availableSummary(db, row, signal) {
  try {
    const value = await summary(db, row, signal);
    return value ? { ...value, name: stateRecords.sessionName(row.session_path, row.session_id, db) } : undefined;
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
  const db = database.open(rootDirectory());

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sdk_session_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      session_path TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL)`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function recentTime(row) {
  try { return row.modified_ns === null ? statSync(row.session_path, { bigint: true }).mtimeNs : BigInt(row.modified_ns); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;

    return undefined;
  }
}

function recentSession(directory, cwd) {
  const db = openListDatabase();

  try {
    const rows = candidates(db, directory, false).map(row => ({ row, time: recentTime(row) })).filter(value => value.time !== undefined);
    rows.sort((a, b) => a.time === b.time ? 0 : a.time > b.time ? -1 : 1);

    return rows.find(({ row }) => sessionHeaderMatches(row.session_path, row.session_id, cwd))?.row.session_path;
  } finally { db.close(); }
}

function installRecentSession(SessionManager) {
  const original = SessionManager.continueRecent;

  if (!(original instanceof Function)) throw new Error("This Pi SDK does not support database session continuation");
  SessionManager.continueRecent = function (cwd, sessionDir) {
    const directory = managedDirectory(sessionDir, rootDirectory());

    if (!directory) return original.call(this, cwd, sessionDir);
    const file = recentSession(directory, cwd);

    return file ? this.open(file, directory, cwd) : this.create(cwd, directory);
  };
}

async function list(directory, cwd, recursive, progress, signal) {
  signal?.throwIfAborted();
  const db = openListDatabase();

  try {
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
  } finally { db.close(); }
}

export function installSessionLists(SessionManager) {
  installRecentSession(SessionManager);
  const originalList = SessionManager.list;
  const originalAll = SessionManager.listAll;

  if (!(originalList instanceof Function) || !(originalAll instanceof Function)) throw new Error("This Pi SDK does not support database session lists");
  SessionManager.list = function (cwd, sessionDir, progress, signal) {
    const directory = managedDirectory(sessionDir, rootDirectory());

    return directory ? list(directory, cwd, false, progress, signal) : originalList.call(this, cwd, sessionDir, progress, signal);
  };

  SessionManager.listAll = function (sessionDirOrProgress, progressOrSignal, signal) {
    const explicit = sessionDirOrProgress?.constructor === String;
    const directory = managedDirectory(explicit ? sessionDirOrProgress : undefined, rootDirectory());

    if (!directory) return originalAll.call(this, sessionDirOrProgress, progressOrSignal, signal);
    const progress = sessionDirOrProgress instanceof Function ? sessionDirOrProgress : progressOrSignal instanceof Function ? progressOrSignal : undefined;
    const abort = explicit || progressOrSignal instanceof Function ? signal : progressOrSignal ?? signal;

    return list(directory, undefined, !explicit, progress, abort);
  };
}
