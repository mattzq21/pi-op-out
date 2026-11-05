import * as database from '../session-database/index.ts';
import { onMainThread } from '../session-database/index.ts';
import { INPUT_HOLD } from '../piop-storage/index.ts';
import { randomUUID } from 'node:crypto';

export interface Goal { id: string; sessionId: string; objective: string; status: 'active' | 'complete'; submissionId?: string }

function validate(goal: unknown): asserts goal is Goal | null {
  const value = goal as Partial<Goal> | null;
  if (value === null) return;
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
    || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.objective !== 'string' || !value.objective.trim()
    || !['active', 'complete'].includes(value.status ?? '')
    || (value.submissionId !== undefined && (typeof value.submissionId !== 'string' || !value.submissionId))) throw new Error('Invalid saved goal');
}

function access<T>(file: string, sessionId: string | undefined, operation: (root: string, id: string) => T): T {
  const root = database.storageRoot(file);
  const id = database.goalSessionId(root, file, sessionId);
  if (!id) throw new Error('Goal storage requires a registered conversation');
  return operation(root, id);
}

function read(file: string, sessionId?: string): Goal | null {
  return access(file, sessionId, (root, id) => {
    const goal = database.sessionGoal(root, id);
    validate(goal);
    return goal;
  });
}

// The goal of the chat file that the submission submissionId set, or null.
function bySubmission(file: string, sessionId: string | undefined, submissionId: string): Goal | null {
  return access(file, sessionId, (root, id) => {
    const goal = database.sessionGoal(root, id);
    validate(goal);

    return goal?.submissionId === submissionId ? goal : null;
  });
}

function restore(file: string): { goal: Goal | null; waitingForInput: boolean } {
  const root = database.storageRoot(file);
  const id = database.goalSessionId(root, file);
  if (!id) return { goal: null, waitingForInput: false };
  const goal = database.sessionGoal(root, id);
  validate(goal);
  const hold = database.currentSessionState(root, id, INPUT_HOLD);
  return { goal, waitingForInput: hold ? JSON.parse(hold)?.data?.held === true : false };
}

const write = onMainThread('goals.write', (file: string, sessionId: string, goal: unknown) => {
  validate(goal);
  if (goal && goal.sessionId !== sessionId) throw new Error('Goal belongs to another conversation');
  access(file, sessionId, (root, id) => {
    if (!goal) database.removeSessionGoal(root, id);
    else database.saveSessionGoal(root, id, goal);
  });
});

// Gives sessionId a copy of the goal of sourceId, if it has one.
function copyGoal(root: string, sourceId: string, sessionId: string): void {
  const goal = database.sessionGoal(root, sourceId);

  if (goal) database.saveSessionGoal(root, sessionId, { id: randomUUID(), objective: goal.objective, status: goal.status });
}

const copy = onMainThread('goals.copy', (source: string, target: string, sessionId: string) => {
  access(target, sessionId, root => {
    const sourceId = database.goalSessionId(root, source);

    if (sourceId) copyGoal(root, sourceId, sessionId);
  });
});

export { read, restore, bySubmission, write, copy, copyGoal, validate };
