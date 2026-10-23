import { hostOperation, runHostOperation, STORAGE_TIMEOUT } from './host_operations';

export interface BranchHistoryRequest {
  root: string;
  sourcePath: string;
  sessionId: string;
  cwd: string;
  entries: any[];
  leafId: string | null;
  entryId: string;
  name?: string;
}
export interface BranchHistoryResult {
  sessionPath: string;
  forkSource: { sessionId: string; sessionPath: string; entryId: string };
}
const history = hostOperation<BranchHistoryRequest, BranchHistoryResult>('chat-branch-history', 'general', STORAGE_TIMEOUT, (value: any) => {
  if (!value || typeof value.sessionPath !== 'string' || !value.forkSource) throw new Error('Invalid branch history result');
  return value;
});
const discard = hostOperation<{ root: string; sessionId: string; sessionPath: string | null }, void>('discard-chat-branch', 'general', STORAGE_TIMEOUT, () => undefined);
export function publishBranchHistory(request: BranchHistoryRequest): Promise<BranchHistoryResult> { return runHostOperation(history, request); }
export function discardBranchHistory(root: string, sessionId: string, sessionPath: string | null): Promise<void> { return runHostOperation(discard, { root, sessionId, sessionPath }); }
