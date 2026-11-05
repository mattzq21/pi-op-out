export interface IndexedChild { sessionId: string; sessionPath: string; kind: string }
export interface ChildIndexRows { version: 1; sessionId: string; sessionPath: string; complete: boolean; children: IndexedChild[] }

export function registeredSessionIds(root: string): string[];
export function releaseReservedSession(root: string, sessionId: string): void;
export function sessionRowExists(root: string, sessionId: string): boolean;
export function isSavedSession(root: string, sessionId: string): boolean;
export function sessionIdByPath(root: string, sessionPath: string): string | undefined;
export function savedSessionsExcept(root: string, exceptId: string): Array<{ session_id: string; session_path: string }>;
export function removeForgottenSessions(root: string, sessionIds: string[], ownershipKeys: string[]): void;
export function setRunningTask(root: string, sessionId: string, running: boolean): void;
export function runningTaskIds(root: string): string[];
export function saveSessionDirectory(root: string, sessionId: string, cwd: string, checkedAt: number, exists: boolean): void;
export function markSessionFileWrite(root: string, sessionId: string): void;
export function saveRegisteredFileMetadata(root: string, sessionId: string, sessionPath: string, modifiedNs: string, size: number | bigint): void;
export function sessionNameOf(root: string, sessionId: string): string | undefined;
export function saveSessionName(root: string, sessionId: string, name: string, replace: boolean): void;
export function readChildIndex(root: string, sessionId: string): ChildIndexRows | undefined;
export function saveChildIndex(root: string, value: ChildIndexRows): void;
export function addIndexedChild(root: string, parentId: string, parentPath: string, child: IndexedChild): void;
export function sessionTreeIds(root: string, sessionId: string): string[];
export function auxiliaryDescendantIds(root: string, parentId: string): string[];
export function externalTranscriptRows(root: string): Array<{ record_id: string; record_json: string }>;
export function saveExternalTranscript(root: string, recordId: string, recordJson: string): void;
export function removeExternalTranscriptRow(root: string, recordId: string, recordJson: string): void;
export function externalTranscriptIdentity(root: string, recordId: string, sessionPath: string): string | null | undefined;
export function setExternalTranscriptIdentity(root: string, recordId: string, sessionId: string): void;
export function chatWorktreeBody(root: string, chatId: string): string | null;
export function chatWorktreeBodies(root: string): string[];
export function writeChatWorktreeBody(root: string, chatId: string, previous: string | null, body: string | null): void;
export function conversationOwnershipBody(root: string, recordKey: string): string | undefined;
export function saveConversationOwnership(root: string, recordKey: string, body: string): void;
export function removeConversationOwnership(root: string, recordKey: string): void;
export function mailboxHasMessages(root: string, sessionId: string): boolean;
export function mailboxHasDelivery(root: string, sessionId: string, deliveryId: string): boolean;
export function subagentRunBodies(root: string, sessionId: string): string[];
