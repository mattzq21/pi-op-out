import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
  try {
    const statement = database.prepare("INSERT INTO sessions (session_id) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM storage_transactions s, json_each(s.journal_json, '$.targets') t WHERE json_extract(t.value, '$.sessionId')=?1) ON CONFLICT(session_id) DO NOTHING");
    for (;;) {
      const id = randomUUID();
      if (Number(statement.run(id).changes) === 1) return id;
    }
  } finally { database.close(); }
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
  if (!ready.has(root)) {
    const output = spawnSync(process.execPath, ['-e', source(), JSON.stringify({ root, action: 'initialize' })], { env: { ...process.env, BUN_BE_BUN: '1', PIOP_STORAGE_DIRECTORY: STORAGE_DIRECTORY }, maxBuffer: 64 * 1024 * 1024 });
    if (output.error) throw output.error;
    if (output.status !== 0) throw new Error(output.stderr.toString());
    ready.add(root);
  }
  const database = openDatabase(join(root, 'sessions.sqlite'), { nofollow: false, timeout: 10_000 });
  try { database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;'); } catch (error) { database.close(); throw error; }
  return database;
}
