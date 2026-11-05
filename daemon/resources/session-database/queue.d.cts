export type SavedQueue = { version: 1; origin: { cwd: string; sessionPath: string | null }; items: any[] };
export type QueueRow = { id: number; message: string; behavior: "steer" | "followUp"; details: string; images: Array<{ mimeType: string | null; data: Buffer; details: string }> };

export function savedQueue(root: string, sessionId: string): SavedQueue | null;
export function queuedInputs(root: string): Array<{ session_id: string; record_json: string }>;
export function queuedInput(root: string, id: string): SavedQueue | undefined;
export function queuedSessionIds(root: string): string[];
export function nextQueueItemId(root: string): string;
export function isQueueHeld(root: string, sessionId: string): boolean;
export function setQueueHeld(root: string, sessionId: string, held: boolean): void;
export function clearQueue(root: string, sessionId: string): void;
export function writeQueue(root: string, sessionId: string, origin: { cwd: string | null; sessionPath: string | null }, items: QueueRow[]): void;
export function bindRecoveredQueue(root: string, sessionId: string, sessionPath: string): boolean;
export function saveRecoveredFileMetadata(root: string, sessionId: string, sessionPath: string, modified: string, size: number): void;

export type SubmissionState = "received" | "accepted" | "rejected";
export function pruneSubmissionOutcomes(root: string, before: number): void;
export function receivedSubmissions(root: string): Array<{ submission_id: string; session_id: string }>;
export function submissionOutcome(root: string, id: string): { session_id: string; outcome: SubmissionState; error: string | null } | undefined;
export function saveSubmissionOutcome(root: string, id: string, sessionId: string, outcome: SubmissionState, error: string | null): void;
export function isGoalSubmissionQueued(root: string, id: string): boolean;

export function mailboxReceiptCache(root: string, sessionId: string, sessionPath: string, fingerprint: string): string | undefined;
export function saveMailboxReceiptCache(root: string, sessionId: string, sessionPath: string, fingerprint: string, deliveriesJson: string): void;
export function mailboxTranscriptFingerprint(root: string, sessionId: string, sessionPath: string): string | undefined;
export function hasMailbox(root: string, sessionId: string): boolean;
export function addMailbox(root: string, sessionId: string): void;
export function mailboxDeliveries(root: string, sessionId: string): unknown[];
export function mailboxDelivery(root: string, sessionId: string, deliveryId: string): unknown;
export function nextMailboxSequence(root: string, sessionId: string): unknown;
export function addMailboxDelivery(root: string, sessionId: string, deliveryId: string, sequence: number, fingerprint: string, messageJson: string): void;
export function removeMailboxDelivery(root: string, sessionId: string, deliveryId: string, fingerprint: string): void;

export function hasSubagentRuns(root: string, sessionId: string): boolean;
export function addSubagentRuns(root: string, sessionId: string): void;
export function subagentRun(root: string, sessionId: string, runId: string): unknown;
export function subagentRuns(root: string, sessionId: string): unknown[];
export function saveSubagentRun(root: string, sessionId: string, runId: string, startedAt: number, runJson: string): void;

export function sessionStateRecord(root: string, sessionId: string, entryId: string): { after_id: string | null; entry_json: string } | undefined;
export function seedSessionStateRecord(root: string, sessionId: string, entryId: string, after: string | null, entryJson: string): void;
export function appendSessionStateRecord(root: string, sessionId: string, entryId: string, after: string | null, entryJson: string): void;
export function sessionStateRecords(root: string, sessionId: string): Array<{ after_id: string | null; entry_json: string }>;
export function sessionStateSequence(root: string, sessionId: string): number;
export function currentSessionStates(root: string, sessionId: string): Array<{ state_key: string; entry_json: string }>;
export function saveCurrentSessionState(root: string, sessionId: string, key: string, entryJson: string): void;
export function branchSelection(root: string, sessionId: string): { tip_id: string | null; leaf_id: string | null } | undefined;
export function saveBranchSelection(root: string, sessionId: string, tipId: string | null, leafId: string | null): void;
