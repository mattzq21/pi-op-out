export type HostOperationName =
  | 'session-descendants' | 'index-sessions' | 'storage-inventory' | 'recover-missing-session' | 'relocate-session'
  | 'chat-branch-history' | 'discard-chat-branch'
  | 'record-session-directory' | 'storage-transaction' | 'temporary-chat' | 'goal-text' | 'agent-definitions' | 'save-agent-definitions' | 'move-agent';

export const QUEUED = 0;
export const STARTED = 1;
export const CANCELLED = 2;

export interface StorageLocks { restore: number; transactions: number }

export interface WorkerJob {
  id: number;
  name: HostOperationName;
  input: unknown;
  progress: SharedArrayBuffer;
  storage?: { root: string; locks: StorageLocks };
}

export type WorkerReply =
  | { id: number; ok: true; result: unknown; cancelled?: boolean }
  | { id: number; ok: false; error: string; state?: string; warning?: string }
  | { fatal: string };
