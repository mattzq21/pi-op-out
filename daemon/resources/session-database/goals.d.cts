export interface SessionGoalRow { id: string; sessionId: string; objective: string; status: string }
export interface GoalRecordRow { record_json: string | null }
export interface GoalIdentityRow { identity: string; record_json: string }

export function goalSessionId(root: string, file: string, sessionId?: string): string | undefined;
export function sessionGoal(root: string, sessionId: string): SessionGoalRow | null;
export function goalInputHold(root: string, sessionId: string): string | undefined;
export function removeSessionGoal(root: string, sessionId: string): void;
export function saveSessionGoal(root: string, sessionId: string, goal: { id: string; objective: string; status: string }): void;

export function goalPreparation(root: string, directory: string, identity: string): GoalRecordRow | undefined;
export function goalPreparationReplaced(root: string, directory: string, identity: string): boolean;
export function goalPreparationsOf(root: string, directory: string): GoalIdentityRow[];
export function saveGoalPreparation(root: string, directory: string, identity: string, text: string): void;
export function goalPreparationRetained(root: string, directory: string, identity: string): boolean;
export function removeGoalPreparation(root: string, directory: string, identity: string): void;

export function goalOwnership(root: string, directory: string, identity: string): GoalRecordRow | undefined;
export function goalOwnershipReplaced(root: string, directory: string, identity: string): boolean;
export function goalOwnershipsOf(root: string, directory: string): GoalIdentityRow[];
export function saveGoalOwnership(root: string, directory: string, identity: string, text: string | null): void;
export function goalOwnershipRetained(root: string, directory: string, identity: string): boolean;
export function removeGoalOwnership(root: string, directory: string, identity: string): void;
export function reserveGoalDirectory(root: string, directory: string): number;
export function publishGoalDirectory(root: string, directory: string, identity: string): void;
export function goalOwnedDirectories(root: string, sessionId?: string): string[];
export function goalDirectoryUnpublished(root: string, directory: string, identity: string): boolean;

export function goalDependency(root: string, directory: string, identity: string): GoalRecordRow | undefined;
export function saveGoalDependency(root: string, directory: string, identity: string, text: string): void;
export function goalDependencyRetained(root: string, directory: string, identity: string): boolean;
export function removeGoalDependency(root: string, directory: string, identity: string): void;
export function goalTextFileNames(root: string, directory: string, identity: string): string | undefined;
export function goalTextContents(root: string, directory: string, identity: string): string | undefined;
export function saveGoalTexts(root: string, directory: string, identity: string, names: string[], contents: Array<{ name: string; text: string }>): void;
export function removeGoalTexts(root: string, directory: string, identity: string): void;
export function goalDirectoryRemade(root: string, directory: string, previous: string, current: string): boolean;
export function goalSavedReferences(root: string, directory: string, identity: string): Array<{ record_json: string | null; contents_json: string }>;

export function goalDirectoryRecovery(root: string, directory: string): string | undefined;
export function saveGoalDirectoryRecovery(root: string, directory: string, record: { staging: string; previous: string; current: string; preparation: string }): void;
export function moveGoalDirectoryRecords(root: string, directory: string, record: { staging: string; previous: string; current: string }): void;
export function goalRecoveriesStagedIn(root: string, staging: string, identity: string): Array<{ directory: string; record_json: string }>;
export function removeGoalDirectoryRecovery(root: string, directory: string, text: string): void;

export function goalReclamation(root: string, key: string): string | undefined;
export function saveGoalReclamation(root: string, key: string, record: { path: string; identity: string }): void;
export function removeGoalReclamation(root: string, key: string): void;

export function goalCleanupSessions(root: string): Array<{ session_id: unknown; session_path: unknown }>;
export function goalCleanupSessionExists(root: string, sessionId: string): boolean;
