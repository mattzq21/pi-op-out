import * as History from '../resources/chat-branch-history.cjs';
import type { BranchHistoryRequest, BranchHistoryResult } from './chat_branch_operations';

/** Runs in a host operation worker: storage publication takes blocking file locks. */
export function publishBranchHistory(request: BranchHistoryRequest): Promise<BranchHistoryResult> {
  if (request.leafId === null) throw new Error('The conversation has no history to branch from');
  return History.publishBranchHistory({ ...request, leafId: request.leafId });
}

/** Removes a branch transcript and everything its publication claimed. Already removed parts count as done. */
export function discardBranchHistory(root: string, sessionId: string, sessionPath: string | null): Promise<void> {
  return History.discardBranchHistory(root, sessionId, sessionPath);
}
