const stateRecords = require('../piop-storage/session-records.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('../piop-storage/session-publication-io.cjs');
const tables = require('../session-database.cjs');

const childSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String(), kind: Type.Union([Type.Literal('subagent'), Type.Literal('review')]) });

const indexSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), sessionPath: Type.String(), complete: Type.Boolean(), children: Type.Array(childSchema) });

const parentSchema = Type.Object({ type: Type.Literal('custom'), customType: Type.String(), data: Type.Object({ sessionId: Type.String(), parentSessionId: Type.String(), parentSessionPath: Type.Optional(Type.String()) }) });

function database(root) {
  const db = tables.open(root);

  try {

    return db;
  } catch (error) { db.close(); throw error; }
}

function read(root, sessionId) {
  const db = database(root);

  try {
    const saved = db.prepare(`SELECT s.session_path, c.complete FROM session_child_state c
      JOIN sessions s USING(session_id) WHERE c.session_id=?`).get(sessionId);

    if (!saved) return;

    const children = db.prepare(`SELECT c.child_id AS sessionId, coalesce(s.session_path, '') AS sessionPath, c.kind
      FROM session_children c JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=?`).all(sessionId);

    return { version: 1, sessionId, sessionPath: saved.session_path ?? '', complete: Boolean(saved.complete), children };
  } finally { db.close(); }
}

function identity(db, sessionId, sessionPath) {
  return Boolean(db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND (? = '' OR session_path=?)").get(sessionId, sessionPath, sessionPath));
}

function write(db, value) {
  if (!identity(db, value.sessionId, value.sessionPath)) return;
  db.prepare(`INSERT INTO session_child_state VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET complete=excluded.complete`)
    .run(value.sessionId, Number(value.complete));
  db.prepare('DELETE FROM session_children WHERE parent_id=?').run(value.sessionId);
  const insert = db.prepare('INSERT INTO session_children (parent_id, child_id, kind) VALUES (?, ?, ?)');

  for (const child of value.children) {
    if (identity(db, child.sessionId, child.sessionPath)) insert.run(value.sessionId, child.sessionId, child.kind);
  }
}

function store(root, value) {
  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');
  const db = database(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    write(db, value);
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function ensure(root, sessionId, sessionPath, complete = false) {
  if (sessionPath) tables.registerPath(root, sessionId, sessionPath);
  const previous = read(root, sessionId);

  if (previous && (!sessionPath || previous.sessionPath === sessionPath)) return previous;
  const value = previous ?? { version: 1, sessionId, sessionPath, complete, children: [] };

  if (sessionPath) value.sessionPath = sessionPath;
  store(root, value);

  return value;
}

function add(root, parentSessionId, parentSessionPath, child) {
  const value = { version: 1, sessionId: parentSessionId, sessionPath: parentSessionPath ?? '', complete: false, children: [child] };

  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');
  const db = database(root);

  try {
    db.exec('BEGIN IMMEDIATE');

    if (identity(db, parentSessionId, value.sessionPath) && identity(db, child.sessionId, child.sessionPath)) {
      db.prepare('INSERT INTO session_child_state VALUES (?, 0) ON CONFLICT(session_id) DO NOTHING').run(parentSessionId);
      db.prepare(`INSERT INTO session_children (parent_id, child_id, kind) VALUES (?, ?, ?)
        ON CONFLICT(parent_id, child_id) DO UPDATE SET kind=excluded.kind`)
        .run(parentSessionId, child.sessionId, child.kind);
    }

    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function registerTranscript(root, sessionPath, body) {
  const entries = stateRecords.merge(sessionPath, body.trim().split('\n').map(JSON.parse));
  const header = entries[0];

  if (!Check(io.headerSchema, header)) throw new Error('Invalid conversation child publication');
  ensure(root, header.id, sessionPath, header.piopChildIndexVersion === 1);

  for (const entry of entries) {
    if (!Check(parentSchema, entry) || entry.data.sessionId !== header.id) continue;
    const kind = entry.customType === 'piop-subagent-parent' ? 'subagent' : entry.customType === 'piop-review-parent' ? 'review' : undefined;

    if (kind) add(root, entry.data.parentSessionId, entry.data.parentSessionPath, { sessionId: header.id, sessionPath, kind });
  }
}

async function initialize(sessionPath, sessionId, fresh) {
  const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

  if (!['sessions', 'archived'].some(area => io.inside(path.join(root, area), sessionPath)) || !io.canonical(path.dirname(sessionPath))) throw new Error('Conversation child index is outside Piop-controlled storage');

  return io.lockedAsync(root, () => {
    if (fresh || read(root, sessionId)) ensure(root, sessionId, sessionPath, fresh);
  });
}

module.exports = { read, store, ensure, add, registerTranscript, initialize };
