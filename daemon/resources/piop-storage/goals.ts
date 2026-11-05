import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import { randomUUID } from 'node:crypto';
import * as GoalAssets from './goal-assets.ts';

export interface Goal { id: string; sessionId: string; objective: string; status: 'active' | 'complete' }

function validate(goal): asserts goal is Goal | null {
  if (goal === null) return;
  if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id
    || typeof goal.sessionId !== 'string' || !goal.sessionId || typeof goal.objective !== 'string'
    || !goal.objective.trim() || [...goal.objective].length > 4000
    || !['active', 'complete'].includes(goal.status)) throw new Error('Invalid saved goal');
}

function access(file, sessionId, operation) {
  const db = database.connection(database.storageRoot(file));
  const row = sessionId
    ? db.prepare('SELECT session_id FROM sessions WHERE session_id=? AND session_path=?').get(sessionId, file)
    : db.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(file);
  if (!row) throw new Error('Goal storage requires a registered conversation');
  return operation(db, row.session_id);
}

function read(file, sessionId?) {
  return access(file, sessionId, (db, id) => {
    const row = db.prepare('SELECT goal_id AS id, session_id AS sessionId, objective, status FROM session_goals WHERE session_id=?').get(id);
    const goal = row ? { ...row } : null;
    validate(goal);
    return goal;
  });
}

function restore(file) {
  const db = database.connection(database.storageRoot(file));
  const row = db.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(file) as { session_id: string } | undefined;
  if (!row) return { goal: null, waitingForInput: false };
  const saved = db.prepare('SELECT goal_id AS id, session_id AS sessionId, objective, status FROM session_goals WHERE session_id=?').get(row.session_id);
  const goal = saved ? { ...saved } : null;
  validate(goal);
  const hold = db.prepare("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-input-hold'").get(row.session_id) as { entry_json: string } | undefined;
  return { goal, waitingForInput: hold ? JSON.parse(hold.entry_json)?.data?.held === true : false };
}

const write = onMainThread('goals.write', (file: string, sessionId: string, goal: Goal | null) => {
  validate(goal);
  if (goal && goal.sessionId !== sessionId) throw new Error('Goal belongs to another conversation');
  access(file, sessionId, (db, id) => {
    if (!goal) db.prepare('DELETE FROM session_goals WHERE session_id=?').run(id);
    else database.transaction(db, 'IMMEDIATE', () => {
      db.prepare('INSERT INTO session_goal_ids VALUES (?, ?) ON CONFLICT(goal_id) DO NOTHING').run(goal.id, id);
      if (db.prepare('SELECT session_id FROM session_goal_ids WHERE goal_id=?').get(goal.id).session_id !== id) throw new Error('Goal identity belongs to another conversation');
      db.prepare(`INSERT INTO session_goals VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status`).run(id, goal.id, goal.objective, goal.status);
    });
  });
});

function copy(source, target, sessionId) {
  const goal = read(source);
  if (goal) {
    GoalAssets.retainHistory(database.storageRoot(target), [{ objective: goal.objective }], sessionId, target);
    write(target, sessionId, { ...goal, id: randomUUID(), sessionId });
  }
}

export { read, restore, write, copy, validate };
