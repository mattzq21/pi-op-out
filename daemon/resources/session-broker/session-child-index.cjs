const stateRecords = require('../piop-storage/session-records.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const tables = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');

const childSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String(), kind: Type.String({ minLength: 1 }) });

const indexSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), sessionPath: Type.String(), complete: Type.Boolean(), children: Type.Array(childSchema) });

function read(root, sessionId) {
  const db = tables.connection(root);
  const saved = db.prepare(`SELECT s.session_path, c.complete FROM auxiliary_child_state c
    JOIN sessions s USING(session_id) WHERE c.session_id=?`).get(sessionId);

  if (!saved) return;

  const children = db.prepare(`SELECT c.child_id AS sessionId, coalesce(s.session_path, '') AS sessionPath, c.kind
    FROM auxiliary_children c JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=?`).all(sessionId);

  return { version: 1, sessionId, sessionPath: saved.session_path ?? '', complete: Boolean(saved.complete), children };
}

function identity(db, sessionId, sessionPath) {
  return Boolean(db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND (? = '' OR session_path=?)").get(sessionId, sessionPath, sessionPath));
}

function write(db, value) {
  if (!identity(db, value.sessionId, value.sessionPath)) return;
  db.prepare(`INSERT INTO auxiliary_child_state VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET complete=excluded.complete`)
    .run(value.sessionId, Number(value.complete));
  db.prepare('DELETE FROM auxiliary_children WHERE parent_id=?').run(value.sessionId);
  const insert = db.prepare('INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)');

  for (const child of value.children) {
    if (identity(db, child.sessionId, child.sessionPath)) insert.run(value.sessionId, child.sessionId, child.kind);
  }
}

const store = onMainThread('session-child-index.store', (root, value) => {
  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');
  const db = tables.connection(root);

  tables.transaction(db, 'IMMEDIATE', () => write(db, value));
});

function ensure(root, sessionId, sessionPath, complete = false) {
  if (sessionPath) tables.registerPath(root, sessionId, sessionPath);
  const previous = read(root, sessionId);

  if (previous && (!sessionPath || previous.sessionPath === sessionPath)) return previous;
  const value = previous ?? { version: 1, sessionId, sessionPath, complete, children: [] };

  if (sessionPath) value.sessionPath = sessionPath;
  store(root, value);

  return value;
}

// Saves, inside the caller's transaction, the index of the new chat sessionId and its link to its parent.
function register(db, sessionId, entries) {
  db.prepare('INSERT INTO auxiliary_child_state VALUES (?, 1) ON CONFLICT(session_id) DO UPDATE SET complete=1').run(sessionId);
  const parent = stateRecords.auxiliaryParent(entries, sessionId);

  if (!parent) return;
  db.prepare('INSERT INTO auxiliary_child_state VALUES (?, 0) ON CONFLICT(session_id) DO NOTHING').run(parent.parentSessionId);
  db.prepare('INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)').run(parent.parentSessionId, sessionId, parent.kind);
}

// The auxiliary chats directly under parentId, with their kind and archive state.
function children(root, parentId) {
  return tables.connection(root).prepare(`SELECT c.child_id AS sessionId, c.kind, s.archived FROM auxiliary_children c
    JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=? AND s.session_path IS NOT NULL`).all(parentId)
    .map(row => ({ sessionId: row.sessionId, kind: row.kind, archived: row.archived === 1 }));
}

function initialize(sessionPath, sessionId, fresh) {
  const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

  if (tables.storageRoot(sessionPath) !== root || fs.realpathSync(path.dirname(sessionPath)) !== path.dirname(sessionPath)) throw new Error('Conversation child index is outside Piop-controlled storage');

  if (fresh || read(root, sessionId)) ensure(root, sessionId, sessionPath, fresh);
}

// The chats of the tree of sessionId: its root chat and every side chat under that root. sessionId comes first.
function tree(root, sessionId) {
  const db = tables.connection(root);
  const parent = db.prepare('SELECT parent_id FROM auxiliary_children WHERE child_id=?');
  let top = sessionId;
  const seen = new Set([sessionId]);
  for (let row; (row = parent.get(top)) && !seen.has(row.parent_id);) { top = row.parent_id; seen.add(top); }
  const rows = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT c.child_id FROM auxiliary_children c JOIN tree t ON c.parent_id=t.id)
    SELECT id FROM tree`).all(top);
  return [...new Set([sessionId, ...rows.map(row => row.id)])];
}

module.exports = { read, store, ensure, register, children, initialize, tree };
