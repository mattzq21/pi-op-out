export function applicationSetting(root: string, name: string): Buffer | undefined;
export function saveApplicationSetting(root: string, name: string, body: Uint8Array): void;
export function createApplicationSetting(root: string, name: string, body: Uint8Array): void;
export function removeApplicationSetting(root: string, name: string): void;

export function projectAgentDefinition(root: string, directory: string): Buffer | undefined;
export function projectAgentDefinitions(root: string): Array<{ directory: string; body: Buffer }>;
export function saveProjectAgentDefinition(root: string, directory: string, body: Uint8Array): void;
export function removeProjectAgentDefinition(root: string, directory: string): void;

export function sdkSettingBody(root: string, path: string): string | null;
export function saveSdkSettingBody(root: string, path: string, body: string): void;

export function saveAgentPromptSnapshot(root: string, digest: string, contents: string): void;
export function agentPromptSnapshot(root: string, digest: string): string | undefined;

export function toolInventoryJson(root: string): string | undefined;
export function saveToolInventoryJson(root: string, entries: string): void;
export function commandInventoryJson(root: string): string | undefined;
export function saveCommandInventoryJson(root: string, entries: string): void;
export function skillInventoryJson(root: string, skillRoot: string): string | undefined;
export function saveSkillInventoryJson(root: string, skillRoot: string, entries: string): void;

export function restartRecordJson(root: string, name: string): string | undefined;
export function saveRestartRecordJson(root: string, name: string, record: string): void;
export function removeRestartRecord(root: string, name: string): void;
export function saveRestartBackup(root: string, id: string, digest: string | null): void;
export function restartBackup(root: string, id: string): { digest: string | null } | undefined;
export function removeRestartBackup(root: string, id: string): void;
export function restartBackupIds(root: string): string[];

export function projectRepositoryJson(root: string, cwd: string): string | null | undefined;
export function saveProjectRepositoryJson(root: string, cwd: string, repository: string | null): void;
export function removeProjectRepository(root: string, cwd: string): void;

export interface SessionGroupRow { id: string; name: string; cwd: string | null; hostId: string | null; hostName: string | null }
export interface SessionGroupOrderRow { scope: string; owner: string; token: string }
export interface SessionGroupRows {
  groups: SessionGroupRow[];
  assignments: Array<[string, string | null]>;
  removedProjects: string[];
  parents: Array<[string, string]>;
  orders: SessionGroupOrderRow[];
}
export function sessionGroupRows(root: string): SessionGroupRows | undefined;
export function replaceSessionGroupRows(root: string, state: {
  groups: SessionGroupRow[];
  assignments: Iterable<[string, string | null]>;
  removedProjects: Iterable<string>;
  parents: Iterable<[string, string]>;
  orders: Iterable<SessionGroupOrderRow & { position: number }>;
}): void;
