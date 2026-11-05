import { storageRoot } from '../../../resources/session-database/index.ts';
import { goalAgentText, goalBySubmission } from '../../../resources/storage-operations/index.ts';

export interface GoalPlace { file: string; sessionId: string; cwd: string }

export function validateObjective(value: string): string {
  const objective = value.trim();
  if (!objective) throw new Error('Goal objective must not be empty.');
  return objective;
}

// The text that gives objective to the agent: the objective, or the path of its goal file when it is long.
export function agentObjective(place: GoalPlace, objective: string): string {
  return goalAgentText(storageRoot(place.file), objective);
}

// The goal of this chat that the submission id set, or null.
export function goalPreparationView(place: GoalPlace, id: string) {
  const goal = goalBySubmission(place.file, place.sessionId, id);
  return goal && { objective: goal.objective, goalId: goal.id, sessionId: place.sessionId, sessionPath: place.file, cwd: place.cwd };
}
