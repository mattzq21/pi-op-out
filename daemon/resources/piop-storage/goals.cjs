const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');
const { randomUUID } = require('node:crypto');

function validate(goal) {
  if (goal === null) return;
  if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id
    || typeof goal.sessionId !== 'string' || !goal.sessionId || typeof goal.objective !== 'string' || !goal.objective.trim()
    || !['active', 'complete'].includes(goal.status)
    || (goal.submissionId !== undefined && (typeof goal.submissionId !== 'string' || !goal.submissionId))) throw new Error('Invalid saved goal');
}

function access(file, sessionId, operation) {
  const db = database.connection(database.storageRoot(file));
  const row = sessionId
    ? db.prepare('SELECT session_id FROM sessions WHERE session_id=? AND session_path=?').get(sessionId, file)
    : db.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(file);
  if (!row) throw new Error('Goal storage requires a registered conversation');
  return operation(db, row.session_id);
}

function saved(db, sessionId) {
  const row = db.prepare('SELECT goal_id, session_id, objective, status, submission_id FROM session_goals WHERE session_id=?').get(sessionId);
  if (!row) return null;
  const goal = { id: row.goal_id, sessionId: row.session_id, objective: row.objective, status: row.status, ...row.submission_id === null ? {} : { submissionId: row.submission_id } };
  validate(goal);
  return goal;
}

function read(file, sessionId) {
  return access(file, sessionId, saved);
}

function restore(file) {
  const db = database.connection(database.storageRoot(file));
  const row = db.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(file);
  if (!row) return { goal: null, waitingForInput: false };
  const goal = saved(db, row.session_id);
  const hold = db.prepare("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-input-hold'").get(row.session_id);
  return { goal, waitingForInput: hold ? JSON.parse(hold.entry_json)?.data?.held === true : false };
}

// The goal of the chat file that the submission submissionId set, or null.
function bySubmission(file, sessionId, submissionId) {
  return access(file, sessionId, (db, id) => {
    const goal = saved(db, id);
    return goal?.submissionId === submissionId ? goal : null;
  });
}

function insert(db, id, goal) {
  db.prepare('INSERT INTO session_goal_ids VALUES (?, ?) ON CONFLICT(goal_id) DO NOTHING').run(goal.id, id);
  if (db.prepare('SELECT session_id FROM session_goal_ids WHERE goal_id=?').get(goal.id).session_id !== id) throw new Error('Goal identity belongs to another conversation');
  db.prepare(`INSERT INTO session_goals VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status, submission_id=excluded.submission_id`)
    .run(id, goal.id, goal.objective, goal.status, goal.submissionId ?? null);
}

const write = onMainThread('goals.write', (file, sessionId, goal) => {
  validate(goal);
  if (goal && goal.sessionId !== sessionId) throw new Error('Goal belongs to another conversation');
  access(file, sessionId, (db, id) => {
    if (!goal) db.prepare('DELETE FROM session_goals WHERE session_id=?').run(id);
    else database.transaction(db, 'IMMEDIATE', () => insert(db, id, goal));
  });
});

function copyFrom(db, source, sessionId) {
  const goal = db.prepare('SELECT g.objective, g.status FROM session_goals g JOIN sessions s USING(session_id) WHERE s.session_path=?').get(source);
  if (goal) insert(db, sessionId, { id: randomUUID(), sessionId, objective: goal.objective, status: goal.status });
}

// Gives the chat target the goal of the chat source, if it has one.
const copy = onMainThread('goals.copy', (source, target, sessionId) => {
  access(target, sessionId, db => database.transaction(db, 'IMMEDIATE', () => copyFrom(db, source, sessionId)));
});

// Binds the reserved sessionId to target and, with source, gives it the goal of source, in one transaction.
const bind = onMainThread('goals.bind', (root, sessionId, target, source) => {
  const db = database.connection(root);
  database.transaction(db, 'IMMEDIATE', () => {
    database.bind(db, sessionId, target);
    if (source !== undefined) copyFrom(db, source, sessionId);
  });
});

module.exports = { read, restore, bySubmission, write, copy, bind, validate };
