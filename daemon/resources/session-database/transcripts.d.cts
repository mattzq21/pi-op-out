export interface LocalSessionRow {
  path: string; modified: string | number | bigint | null; size: number | null; name: string | null;
  branch_session: string | null; branch_tip: string | null; branch_leaf: string | null;
}
export function localSessionRows(root: string, prefix: string, resolved: string): LocalSessionRow[];
export function captureSessionFileMetadata(root: string, file: string, modified: string, size: number): void;
export function forgetSessionFileMetadata(root: string, file: string): void;
export function saveSessionFileMetadata(root: string, file: string, modified: string, size: number | bigint): void;

export interface SidebarSummaryRow { session_id: string; session_path: string; fingerprint: string; modified_at: number; summary_json: string }
export function sidebarSummaries(root: string): SidebarSummaryRow[];
export interface SidebarSummary { id: string; path: string; fingerprint: string; modifiedAt: number; json: string }
export function replaceSidebarSummaries(root: string, summaries: Iterable<SidebarSummary>): void;

export function storageTranscriptSummary(root: string, file: string, stamp: string): Uint8Array | undefined;
export function saveStorageTranscriptSummary(root: string, file: string, stamp: string, body: Uint8Array): void;

export function transcriptReferenceEntries(root: string, file: string, stamp: string): string | undefined;
export function saveTranscriptReference(root: string, file: string, sessionId: string | null, stamp: string, entriesJson: string): void;
export function appendTranscriptReference(root: string, file: string, previous: string, stamp: string, entryJson: string | undefined): boolean;
export function saveMailboxReceipts(root: string, sessionId: string, file: string, fingerprint: string, deliveriesJson: string): void;
export function appendMailboxReceipts(root: string, sessionId: string, file: string, previous: string, fingerprint: string, deliveryJson: string | undefined): boolean;
export function removeTranscriptCachesUnder(root: string, directory: string): void;

export interface SdkSessionListRow {
  session_id: string; session_path: string; modified_ns: string | number | bigint | null; size: number | null;
  fingerprint: string | null; body: string | null;
}
export function sdkSessionListRows(root: string, directory: string, recursive: boolean): SdkSessionListRow[];
export function saveSdkSessionSummary(root: string, sessionId: string, file: string, stamp: string, body: string): void;
export function sdkSettingsText(root: string, file: string): string | undefined;
