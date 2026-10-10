import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openDatabase, type Database } from './util/db';
import { setPrivateFilePermissions } from './private_fs';

function profile(directory: string): string {
  const parent = dirname(directory);
  if (parent !== directory && basename(parent) === 'daemons') return dirname(parent);
  return directory;
}

function open(directory: string): Database {
  const root = profile(directory);
  mkdirSync(root, { recursive: true });
  const file = join(root, 'sessions.sqlite');
  const db = openDatabase(file, { nofollow: true, timeout: 10_000 });
  try {
    setPrivateFilePermissions(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;' +
      ' CREATE TABLE IF NOT EXISTS daemon_restart_records (directory TEXT NOT NULL, name TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(directory, name));' +
      ' CREATE TABLE IF NOT EXISTS daemon_restart_backups (directory TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, id));');
  } catch (error) { db.close(); throw error; }
  return db;
}

function use<T>(directory: string, operation: (db: Database) => T): T {
  const db = open(directory);
  try { return operation(db); } finally { db.close(); }
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
  try { directory = realpathSync(parent); } catch {}
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
