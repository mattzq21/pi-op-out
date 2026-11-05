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

function restore(file: string): { goal: Goal | null; waitingForInput: boolean } {
  const root = database.storageRoot(file);
  const id = database.goalSessionId(root, file);
  if (!id) return { goal: null, waitingForInput: false };
  const goal = database.sessionGoal(root, id);
  validate(goal);
  const hold = database.goalInputHold(root, id);
  return { goal, waitingForInput: hold ? JSON.parse(hold)?.data?.held === true : false };
}

const write = onMainThread('goals.write', (file: string, sessionId: string, goal: Goal | null) => {
  validate(goal);
  if (goal && goal.sessionId !== sessionId) throw new Error('Goal belongs to another conversation');
  access(file, sessionId, (root, id) => {
    if (!goal) database.removeSessionGoal(root, id);
    else database.saveSessionGoal(root, id, goal);
  });
});

function copy(source: string, target: string, sessionId: string): void {
  const goal = read(source);
  if (goal) {
    GoalAssets.retainHistory(database.storageRoot(target), [{ objective: goal.objective }], sessionId, target);
    write(target, sessionId, { ...goal, id: randomUUID(), sessionId });
  }
}

export { read, restore, write, copy, validate };
