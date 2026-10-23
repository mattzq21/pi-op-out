const database = require('../session-database.cjs');
const { randomUUID } = require('node:crypto');

function validate(goal) {
  if (goal === null) return;
  if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id
    || typeof goal.sessionId !== 'string' || !goal.sessionId || typeof goal.objective !== 'string'
    || !goal.objective.trim() || [...goal.objective].length > 4000
    || !['active', 'paused', 'complete'].includes(goal.status)) throw new Error('Invalid saved goal');
}

function access(file, sessionId, operation) {
  const db = database.open(database.storageRoot(file));
  try {
    const row = sessionId
      ? db.prepare('SELECT session_id FROM sessions WHERE session_id=? AND session_path=?').get(sessionId, file)
      : db.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(file);
    if (!row) throw new Error('Goal storage requires a registered conversation');
    return operation(db, row.session_id);
  } finally { db.close(); }
}

function read(file, sessionId) {
  return access(file, sessionId, (db, id) => {
    const row = db.prepare('SELECT goal_id AS id, session_id AS sessionId, objective, status FROM session_goals WHERE session_id=?').get(id);
    const goal = row ? { ...row } : null;
    validate(goal);
    return goal;
  });
}

function write(file, sessionId, goal) {
  validate(goal);
  if (goal && goal.sessionId !== sessionId) throw new Error('Goal belongs to another conversation');
  access(file, sessionId, (db, id) => {
    if (!goal) db.prepare('DELETE FROM session_goals WHERE session_id=?').run(id);
    else {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO session_goal_ids VALUES (?, ?) ON CONFLICT(goal_id) DO NOTHING').run(goal.id, id);
        if (db.prepare('SELECT session_id FROM session_goal_ids WHERE goal_id=?').get(goal.id).session_id !== id) throw new Error('Goal identity belongs to another conversation');
        db.prepare(`INSERT INTO session_goals VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status`).run(id, goal.id, goal.objective, goal.status);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  });
}

function copy(source, target, sessionId) {
  const goal = read(source);
  if (goal) {
    require('./goal-assets.cjs').retainHistory(database.storageRoot(target), [{ objective: goal.objective }], sessionId, target);
    write(target, sessionId, { ...goal, id: randomUUID(), sessionId });
  }
}

function known(file, sessionId, goalId) {
  return access(file, sessionId, (db, id) => Boolean(db.prepare('SELECT 1 FROM session_goal_ids WHERE session_id=? AND goal_id=?').get(id, goalId)));
}

module.exports = { read, write, copy, validate, known };
