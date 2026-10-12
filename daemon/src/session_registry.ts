import { z } from 'zod';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as SessionTables from '../resources/session-database.cjs';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import type { Host } from './host_connection';
import { hostScript, runHostScript } from './host_script';
import { claimPath } from './session_worker';
import { tryLockFileSync } from './util/flock';
import { openDatabase, type Database } from './util/db';

type RegistryRequest =
  | { action: 'reserve' }
  | { action: 'identity'; path: string }
  | { action: 'ids' }
  | { action: 'record'; root: string; sessionId: string; sessionPath: string | null; cwd: string; checkedAt: number };

const sessionIdSchema = z.string().min(1);
const reserveScript = hostScript<RegistryRequest, string>('session-registry', 16 * 1024 * 1024, value => sessionIdSchema.parse(value));
const identityScript = hostScript<RegistryRequest, string | null>('session-registry', 16 * 1024 * 1024, value => sessionIdSchema.nullable().parse(value));
const idsScript = hostScript<RegistryRequest, string[]>('session-registry', 16 * 1024 * 1024, value => z.array(sessionIdSchema).parse(value));
const recordScript = hostScript<RegistryRequest, null>('session-registry', 16 * 1024 * 1024, value => z.null().parse(value));

/** Reserves a new session ID in the registry of the host. */
export async function reserveOn(host: Host): Promise<string> {
  return runHostScript(host, reserveScript, { action: 'reserve' });
}

/** Returns the registered session ID of the transcript at path, or undefined. */
export async function identityOn(host: Host, path: string): Promise<string | undefined> {
  return (await runHostScript(host, identityScript, { action: 'identity', path })) ?? undefined;
}

/** Returns all session IDs in the registry of the host. */
export async function idsOn(host: Host): Promise<string[]> {
  return runHostScript(host, idsScript, { action: 'ids' });
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
  const request: RegistryRequest = { action: 'record', root: join(homeDir(), STORAGE_DIRECTORY), sessionId: id, sessionPath: state.sessionFile ?? null, cwd, checkedAt: Date.now() };
  // Only the latest update per session is kept, and one worker writes them in order, so bursts of events start one process at a time.
  pendingRecords.delete(id);
  pendingRecords.set(id, request);
  if (!recording) void writeRecords();
}

const pendingRecords = new Map<string, RegistryRequest>();
let recording = false;

async function writeRecords(): Promise<void> {
  recording = true;
  try {
    for (let next = pendingRecords.entries().next(); !next.done; next = pendingRecords.entries().next()) {
      const [id, request] = next.value;
      pendingRecords.delete(id);
      try { await runHostScript({ kind: 'local' }, recordScript, request); }
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
