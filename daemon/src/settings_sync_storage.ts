import { basename, dirname, join } from 'node:path';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import { openDatabase, withDatabase, type Database } from './util/db';

function open(path: string): Database {
  const root = dirname(path);
  ensurePrivateDir(root);
  const file = join(root, 'sessions.sqlite');
  const database = openDatabase(file, { timeout: 10_000 });
  try {
    setPrivateFilePermissions(file);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings_sync_records (name TEXT PRIMARY KEY, record_json TEXT);`);
  } catch (error) { database.close(); throw error; }
  return database;
}

function name(path: string): string {
  const key = basename(path);
  if (!key) throw new Error('Invalid settings synchronization record name');
  return key;
}

export function readRecord<T>(path: string, fallback: () => T): T {
  return withDatabase(open(path), database => {
    const row = database.prepare('SELECT record_json FROM settings_sync_records WHERE name=?').get(name(path)) as { record_json: string | null } | undefined;
    if (!row?.record_json) return fallback();
    try { return { ...fallback(), ...JSON.parse(row.record_json) }; }
    catch (error: any) { throw new Error(`Could not read settings synchronization record ${path}: ${error.message}`); }
  });
}

export function writeRecord(path: string, value: unknown): void {
  withDatabase(open(path), database => {
    database.prepare('INSERT INTO settings_sync_records VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET record_json=excluded.record_json').run(name(path), JSON.stringify(value));
  });
}
