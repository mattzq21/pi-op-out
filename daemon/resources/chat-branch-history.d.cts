export interface BranchHistoryRequest {
  root: string;
  sourcePath: string;
  sessionId: string;
  cwd: string;
  entries: any[];
  leafId: string;
  entryId: string;
  name?: string;
}

export interface BranchHistoryResult {
  sessionPath: string;
  forkSource: { sessionId: string; sessionPath: string; entryId: string };
}

export function publishBranchHistory(request: BranchHistoryRequest): Promise<BranchHistoryResult>;
export function discardBranchHistory(root: string, sessionId: string, sessionPath: string | null): Promise<void>;
