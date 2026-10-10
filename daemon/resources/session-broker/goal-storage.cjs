const { acquireReferencePublicationLock } = require('./reference-publication-lock.cjs');
const database = require('../session-database.cjs');

function transaction(root, operation) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    const result = operation(db);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function load(db, sessionId) {
  const row = db.prepare(`SELECT g.*, a.goal_id, a.usage_json FROM session_goals g
    JOIN session_goal_accounting a USING(session_id) WHERE g.session_id=? AND a.current=1`).get(sessionId);

  if (!row) return null;

  return { id: row.goal_id, sessionId, objective: row.objective, status: row.status,
    tokenBudget: row.token_budget, tokensUsed: row.tokens_used, elapsedMs: row.elapsed_ms,
    subagentUsage: JSON.parse(row.usage_json) };
}

function read(root, sessionId) { return transaction(root, db => load(db, sessionId)); }

function known(root, sessionId, goalId) {
  return transaction(root, db => Boolean(db.prepare('SELECT 1 FROM session_goal_accounting WHERE session_id=? AND goal_id=?').get(sessionId, goalId)));
}

function store(db, sessionId, goal) {
  if (!db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(sessionId)) throw new Error('Cannot save a goal for a deleted session');
  db.prepare('UPDATE session_goal_accounting SET current=0 WHERE session_id=?').run(sessionId);

  if (!goal) {
    db.prepare('DELETE FROM session_goals WHERE session_id=?').run(sessionId);

    return;
  }

  db.prepare(`INSERT INTO session_goals VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET objective=excluded.objective, status=excluded.status,
    token_budget=excluded.token_budget, tokens_used=excluded.tokens_used, elapsed_ms=excluded.elapsed_ms`)
    .run(sessionId, goal.objective, goal.status, goal.tokenBudget, goal.tokensUsed, goal.elapsedMs);
  db.prepare(`INSERT INTO session_goal_accounting VALUES (?, ?, 1, ?)
    ON CONFLICT(session_id, goal_id) DO UPDATE SET current=1, usage_json=excluded.usage_json`)
    .run(sessionId, goal.id, JSON.stringify(goal.subagentUsage ?? {}));
}

function write(root, sessionId, goal) {
  transaction(root, db => store(db, sessionId, goal));

  if (!goal) process.emit('piop:goal-cleared', sessionId);
}

function copy(root, sourceId, targetId) {
  const release = acquireReferencePublicationLock(root, true);

  try {
    database.copyGoal(root, sourceId, targetId);
  } finally { release(); }
}

module.exports = { read, known, write, copy };
