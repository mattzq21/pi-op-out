import { connection, transaction } from './core.ts';
import type { SQLInputValue } from 'node:sqlite';

export interface SessionGoalRow { id: string; sessionId: string; objective: string; status: string; submissionId?: string }


// Goals of chats.

function get<T>(root: string, sql: string, ...parameters: SQLInputValue[]): T | undefined { return connection(root).prepare(sql).get(...parameters) as T | undefined; }

function goalSessionId(root: string, file: string, sessionId?: string): string | undefined {
  const row = sessionId
    ? get<{ session_id: string }>(root, 'SELECT session_id FROM sessions WHERE session_id=? AND session_path=?', sessionId, file)
    : get<{ session_id: string }>(root, 'SELECT session_id FROM sessions WHERE session_path=?', file);

  return row?.session_id;
}

function sessionGoal(root: string, sessionId: string): SessionGoalRow | null {
  const row = get<{ id: string; sessionId: string; objective: string; status: string; submissionId: string | null }>(root,
    'SELECT goal_id AS id, session_id AS sessionId, objective, status, submission_id AS submissionId FROM session_goals WHERE session_id=?', sessionId);

  if (!row) return null;

  return { id: row.id, sessionId: row.sessionId, objective: row.objective, status: row.status, ...row.submissionId === null ? {} : { submissionId: row.submissionId } };
}

function goalInputHold(root: string, sessionId: string): string | undefined {
  return get<{ entry_json: string }>(root, "SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-input-hold'", sessionId)?.entry_json;
}

function removeSessionGoal(root: string, sessionId: string): void { connection(root).prepare('DELETE FROM session_goals WHERE session_id=?').run(sessionId); }

function saveSessionGoal(root: string, sessionId: string, goal: { id: string; objective: string; status: string; submissionId?: string }): void {
  transaction(root, 'IMMEDIATE', () => {
    const db = connection(root);
    db.prepare('INSERT INTO session_goal_ids VALUES (?, ?) ON CONFLICT(goal_id) DO NOTHING').run(goal.id, sessionId);

    if ((db.prepare('SELECT session_id FROM session_goal_ids WHERE goal_id=?').get(goal.id) as { session_id: string } | undefined)?.session_id !== sessionId) throw new Error('Goal identity belongs to another conversation');
    db.prepare(`INSERT INTO session_goals VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status, submission_id=excluded.submission_id`)
      .run(sessionId, goal.id, goal.objective, goal.status, goal.submissionId ?? null);
  });
}

// The objectives that goal rows own. Goal files keep only these.
function goalObjectives(root: string): string[] {
  return connection(root).prepare('SELECT DISTINCT objective FROM session_goals').all().map(row => row.objective as string);
}

export { goalSessionId, sessionGoal, goalInputHold, removeSessionGoal, saveSessionGoal, goalObjectives };
