/** Messages between the daemon and its host operation workers. */

export type HostOperationName =
  | 'session-descendants' | 'index-sessions' | 'storage-inventory' | 'recover-missing-session' | 'relocate-session'
  | 'chat-branch-history' | 'discard-chat-branch'
  | 'record-session-directory' | 'storage-transaction' | 'temporary-chat' | 'goal-text' | 'agent-definitions';

/** Values of the shared progress cell of a job. Whichever side changes QUEUED first decides if the operation starts. */
export const QUEUED = 0;
export const STARTED = 1;
export const CANCELLED = 2;

/** Descriptors of the storage lock files, opened by the daemon and locked by the worker. */
export interface StorageLocks { restore: number; transactions: number }

export interface WorkerJob {
  id: number;
  name: HostOperationName;
  input: unknown;
  progress: SharedArrayBuffer;
  storage?: { root: string; locks: StorageLocks };
}

export type WorkerReply =
  /** cancelled: the caller gave up before the operation started, so it did not run. */
  | { id: number; ok: true; result: unknown; cancelled?: boolean }
  | { id: number; ok: false; error: string; state?: string; warning?: string }
  | { fatal: string };
