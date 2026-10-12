import { z } from 'zod';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as SessionTables from '../resources/session-database.cjs';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { DEFAULT_TIMEOUT, hostOperation, runHostOperation } from './host_operations';
import { claimPath } from './session_worker';
import { tryLockFileSync } from './util/flock';
import { openDatabase, type Database } from './util/db';

type RecordRequest = { root: string; sessionId: string; sessionPath: string | null; cwd: string; checkedAt: number };

const recordOperation = hostOperation<RecordRequest, null>('record-session-directory', 'general', DEFAULT_TIMEOUT, value => z.null().parse(value));

/** Returns all session IDs in the registry at root. */
export function ids(root: string): string[] {
  const database = open(root);
  try { return (database.prepare('SELECT session_id FROM sessions').all() as Array<{ session_id: string }>).map(row => row.session_id); }
  finally { database.close(); }
}

export function reserve(root: string): string {
  const database = open(root);
  try { return SessionTables.reserveId(database); } finally { database.close(); }
}

/**
 * Removes a reserved ID that never got a transcript. Nothing is removed while a Pi process holds the session claim,
 * because that Pi can still create the transcript.
 */
export function releaseReservation(root: string, id: string): void {
  const claim = tryLockFileSync(claimPath(id));
  if (!claim) return;
  try {
    const database = open(root);
    try { database.prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(id); } finally { database.close(); }
  } finally { claim.release(); }
}

export function pending(root: string, work: 'transaction' | 'recovery' | 'retention'): boolean {
  const database = open(root);
  try { return SessionTables.pending(database, work); } finally { database.close(); }
}

export function requestCleanup(root: string, kind: 'goal'): void {
  SessionTables.markCleanup(root, kind);
}

export function record(state: any, cwd: string | undefined | null): void {
  const id = typeof state?.sessionId === 'string' ? state.sessionId : undefined;
  if (!id || typeof cwd !== 'string') return;
  const request: RecordRequest = { root: join(homeDir(), STORAGE_DIRECTORY), sessionId: id, sessionPath: state.sessionFile ?? null, cwd, checkedAt: Date.now() };
  // Only the latest update per session is kept, and the updates are written one at a time, so a burst of events runs one operation at a time.
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

const ready = new Set<string>();

export function open(root: string): Database {
  const file = join(root, 'sessions.sqlite');
  if (!ready.has(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const database = openDatabase(file, { nofollow: false, timeout: 10_000 });
  try {
    if (!ready.has(root)) {
      chmodSync(file, 0o600);
      SessionTables.initialize(database);
      ready.add(root);
    }
    database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  } catch (error) { database.close(); throw error; }
  return database;
}
