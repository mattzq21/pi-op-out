import { storageRoot } from '../../../resources/session-database.ts';
import { agentText } from '../../../resources/piop-storage/goal-files.ts';
import { bySubmission } from '../../../resources/piop-storage/goals.ts';

export interface GoalPlace { file: string; sessionId: string; cwd: string }

export function validateObjective(value: string): string {
  const objective = value.trim();
  if (!objective) throw new Error('Goal objective must not be empty.');
  return objective;
}

// The text that gives objective to the agent: the objective, or the path of its goal file when it is long.
export function agentObjective(place: GoalPlace, objective: string): string {
  return agentText(storageRoot(place.file), objective);
}

// The goal of this chat that the submission id set, or null.
export function goalPreparationView(place: GoalPlace, id: string) {
  const goal = bySubmission(place.file, place.sessionId, id);
  return goal && { objective: goal.objective, goalId: goal.id, sessionId: place.sessionId, sessionPath: place.file, cwd: place.cwd };
}
