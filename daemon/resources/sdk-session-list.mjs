import { createReadStream, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import database from "./session-database.cjs";

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
  const rows = db.prepare(`SELECT s.session_id, s.session_path, m.modified_ns, m.size, c.fingerprint, c.body
    FROM sessions s LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path
    LEFT JOIN sdk_session_summaries c ON c.session_id=s.session_id AND c.session_path=s.session_path
    WHERE s.session_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(s.session_id))`).all();

  return rows.filter(row => recursive ? row.session_path.startsWith(directory + sep) : dirname(row.session_path) === directory)
    .sort((a, b) => basename(b.session_path).localeCompare(basename(a.session_path)));
}

function fingerprint(row) {
  if (row.modified_ns !== null) return `${row.modified_ns}:${row.size}`;
  const stat = statSync(row.session_path, { bigint: true });

  return `${stat.mtimeNs}:${stat.size}`;
}

function decode(body) {
  const value = JSON.parse(body);

  return { ...value, created: new Date(value.created ?? NaN), modified: new Date(value.modified ?? NaN) };
}

function entry(line) {
  try { return JSON.parse(line); }
  catch { return undefined; }
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

  if (record.type === "session_info") state.name = record.name?.trim() || undefined;

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
  const input = createReadStream(row.session_path, { encoding: "utf8", signal });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      signal?.throwIfAborted();

      if (!collectEntry(state, entry(line))) return undefined;
    }
  } finally { lines.close(); input.destroy(); }

  return summaryValue(row, state);
}

async function summary(db, row, signal) {
  const stamp = fingerprint(row);
  const previous = cached.get(row.session_path);

  if (previous?.stamp === stamp && previous.id === row.session_id) return structuredClone(previous.value);
  const value = row.fingerprint === stamp && row.body ? decode(row.body) : await readSummary(row, signal);

  if (!value) return undefined;
  const stat = row.fingerprint === stamp ? undefined : statSync(row.session_path, { bigint: true });

  if (stat && stamp !== `${stat.mtimeNs}:${stat.size}`) return value;
  persistSummary(db, row, stamp, value);
  remember(row, stamp, value);

  return structuredClone(value);
}

function persistSummary(db, row, stamp, value) {
  if (row.fingerprint === stamp && row.body) return;
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
  try { return await summary(db, row, signal); }
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

async function list(directory, cwd, recursive, progress, signal) {
  signal?.throwIfAborted();
  const db = database.open(rootDirectory());

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sdk_session_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      session_path TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL)`);
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
