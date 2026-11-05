import * as History from '../storage';
import type { BranchHistoryRequest, BranchHistoryResult } from '../worktrees';

export function publishBranchHistory(request: BranchHistoryRequest): Promise<BranchHistoryResult> {
  if (request.leafId === null) throw new Error('The conversation has no history to branch from');
  return History.publishBranchHistory({ ...request, leafId: request.leafId });
}

export function discardBranchHistory(root: string, sessionId: string, sessionPath: string | null): Promise<void> {
  return History.discardBranchHistory(root, sessionId, sessionPath);
}
