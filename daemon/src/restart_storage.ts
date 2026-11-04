import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { connection, type Database } from './util/db';
import { isMissing } from './util/sync';

function use<T>(directory: string, operation: (db: Database) => T): T {
  return operation(connection(directory));
}

export function saveBackup(directory: string, id: string, record: any): void {
  use(directory, db => db.prepare('INSERT INTO daemon_restart_backups VALUES (?, ?, ?) ON CONFLICT(directory, id) DO UPDATE SET record_json=excluded.record_json').run(directory, id, JSON.stringify(record)));
}

export function readBackup(directory: string, id: string): any | null {
  const row: any = use(directory, db => db.prepare('SELECT record_json FROM daemon_restart_backups WHERE directory=? AND id=?').get(directory, id));
  if (!row || row.record_json === null) return null;
  return JSON.parse(row.record_json);
}

export function removeBackup(directory: string, id: string): void {
  use(directory, db => db.prepare('DELETE FROM daemon_restart_backups WHERE directory=? AND id=?').run(directory, id));
}

export function backups(directory: string): string[] {
  return use(directory, db => db.prepare('SELECT id FROM daemon_restart_backups WHERE directory=? ORDER BY id').all(directory).map((row: any) => String(row.id)));
}

function location(path: string): [string, string] {
  const parent = dirname(path);
  let directory = parent;
  try { directory = realpathSync(parent); } catch (error) { if (!isMissing(error)) throw error; }
  const name = basename(path);
  if (!name) throw new Error('Invalid restart record name');
  return [directory, name];
}

export function read(path: string): any | null {
  const [directory, name] = location(path);
  const row: any = use(directory, db => db.prepare('SELECT record_json FROM daemon_restart_records WHERE directory=? AND name=?').get(directory, name));
  return row ? JSON.parse(row.record_json) : null;
}

export function write(path: string, value: any): void {
  const [directory, name] = location(path);
  use(directory, db => db.prepare('INSERT INTO daemon_restart_records VALUES (?, ?, ?) ON CONFLICT(directory, name) DO UPDATE SET record_json=excluded.record_json').run(directory, name, JSON.stringify(value)));
}

export function remove(path: string): void {
  const [directory, name] = location(path);
  use(directory, db => db.prepare('DELETE FROM daemon_restart_records WHERE directory=? AND name=?').run(directory, name));
}
