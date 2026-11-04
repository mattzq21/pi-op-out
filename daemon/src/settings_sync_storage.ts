import { basename, dirname } from 'node:path';
import { connection } from './util/db';

function name(path: string): string {
  const key = basename(path);
  if (!key) throw new Error('Invalid settings synchronization record name');
  return key;
}

export function readRecord<T>(path: string, fallback: () => T): T {
  const row = connection(dirname(path)).prepare('SELECT record_json FROM settings_sync_records WHERE name=?').get(name(path)) as { record_json: string | null } | undefined;
  if (!row?.record_json) return fallback();
  try { return { ...fallback(), ...JSON.parse(row.record_json) }; }
  catch (error: any) { throw new Error(`Could not read settings synchronization record ${path}: ${error.message}`); }
}

export function writeRecord(path: string, value: unknown): void {
  connection(dirname(path)).prepare('INSERT INTO settings_sync_records VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET record_json=excluded.record_json').run(name(path), JSON.stringify(value));
}
