export type HostOperationName =
  | 'index-sessions' | 'storage-inventory' | 'recover-missing-session' | 'relocate-session'
  | 'chat-branch-history' | 'discard-chat-branch'
  | 'session-storage' | 'temporary-chat' | 'agent-definitions' | 'save-agent-definitions' | 'move-agent';

export const QUEUED = 0;
export const STARTED = 1;
export const CANCELLED = 2;

export interface WorkerJob {
  id: number;
  name: HostOperationName;
  input: unknown;
  progress: SharedArrayBuffer;
  storage?: { root: string };
}

export type WorkerReply =
  | { id: number; ok: true; result: unknown; cancelled?: boolean }
  | { id: number; ok: false; error: string }
  | { fatal: string };
