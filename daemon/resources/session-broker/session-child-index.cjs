const stateRecords = require('../piop-storage/session-records.cjs');
const tables = require('../session-database.cjs');

// Saves, inside the caller's transaction, the link of the new chat sessionId to its parent.
function register(db, sessionId, entries) {
  const parent = stateRecords.auxiliaryParent(entries, sessionId);

  if (parent) db.prepare('INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)').run(parent.parentSessionId, sessionId, parent.kind);
}

// The auxiliary chats directly under parentId, with their kind and archive state.
function children(root, parentId) {
  return tables.connection(root).prepare(`SELECT c.child_id AS sessionId, c.kind, s.archived FROM auxiliary_children c
    JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=? AND s.session_path IS NOT NULL`).all(parentId)
    .map(row => ({ sessionId: row.sessionId, kind: row.kind, archived: row.archived === 1 }));
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

module.exports = { register, children, tree };
