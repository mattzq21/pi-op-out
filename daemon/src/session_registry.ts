import { z } from 'zod';
import { join } from 'node:path';
import * as SessionTables from '../resources/session-database.cjs';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { DEFAULT_TIMEOUT, hostOperation, runHostOperation } from './host_operations';

type RecordRequest = { root: string; sessionId: string; sessionPath: string | null; cwd: string; checkedAt: number };

const recordOperation = hostOperation<RecordRequest, null>('record-session-directory', 'general', DEFAULT_TIMEOUT, z.null());

export function ids(root: string): string[] {
  return SessionTables.registeredSessionIds(root);
}

export function reserve(root: string): string {
  return SessionTables.reserveId(root);
}

// Gives back an identity that was reserved and not used for a saved chat.
export function releaseReservation(root: string, id: string): void {
  SessionTables.releaseReservedSession(root, id);
}

export function pending(root: string, work: 'transaction' | 'recovery' | 'retention'): boolean {
  return SessionTables.pending(root, work);
}

export function setTaskRunning(root: string, id: string, running: boolean): void {
  SessionTables.setRunningTask(root, id, running);
}

export function runningTasks(root: string): string[] {
  return SessionTables.runningTaskIds(root);
}

export function requestCleanup(root: string, kind: 'goal'): void {
  SessionTables.markCleanup(root, kind);
}

export function record(state: any, cwd: string | undefined | null): void {
  const id = typeof state?.sessionId === 'string' ? state.sessionId : undefined;
  if (!id || typeof cwd !== 'string') return;
  const request: RecordRequest = { root: join(homeDir(), STORAGE_DIRECTORY), sessionId: id, sessionPath: state.sessionFile ?? null, cwd, checkedAt: Date.now() };
  pendingRecords.delete(id);
  pendingRecords.set(id, request);
  if (!recording) void writeRecords();
}

const pendingRecords = new Map<string, RecordRequest>();
let recording = false;

async function writeRecords(): Promise<void> {
  recording = true;
  try {
    for (let next = pendingRecords.entries().next(); !next.done; next = pendingRecords.entries().next()) {
      const [id, request] = next.value;
      pendingRecords.delete(id);
      try { await runHostOperation(recordOperation, request); }
      catch (error: any) { console.error(`Session registry: ${error?.message ?? error}`); }
    }
  } finally { recording = false; }
}
