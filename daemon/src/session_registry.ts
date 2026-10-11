import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as SessionTables from '../resources/session-database.cjs';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { sessionDatabase, sessionRegistryBundle } from './resources';
import { openDatabase, type Database } from './util/db';

export function source(): string { return sessionRegistryBundle; }

export function withDatabase(script: string): string {
  return `const sessionDatabase = (() => { const module = {exports:{}}; ${sessionDatabase} return module.exports; })();\n${script.replaceAll("require('./session-database.cjs')", 'sessionDatabase')}`;
}

export function reserve(root: string): string {
  const database = open(root);
  try { return SessionTables.reserveId(database); } finally { database.close(); }
}

export function pending(root: string, work: 'transaction' | 'recovery' | 'retention'): boolean {
  const database = open(root);
  try { return SessionTables.pending(database, work); } finally { database.close(); }
}

export function requestCleanup(root: string, kind: 'goal'): void {
  SessionTables.markCleanup(root, kind);
}

function run(request: Record<string, unknown>): void {
  try {
    request.root = join(homeDir(), STORAGE_DIRECTORY);
    const child = spawn(process.execPath, ['-e', source(), JSON.stringify(request)], { env: { ...process.env, BUN_BE_BUN: '1', PIOP_STORAGE_DIRECTORY: STORAGE_DIRECTORY }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', error => console.error(`Session registry: ${error.message}`));
    child.on('close', code => { if (code !== 0 || stderr) console.error(`Session registry: ${stderr}`); });
  } catch (error: any) { console.error(`Session registry: ${error?.message ?? error}`); }
}

export function record(state: any, cwd: string | undefined | null): void {
  const id = typeof state?.sessionId === 'string' ? state.sessionId : undefined;
  if (!id || typeof cwd !== 'string') return;
  run({ action: 'record', sessionId: id, sessionPath: state.sessionFile ?? null, cwd, checkedAt: Date.now() });
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
