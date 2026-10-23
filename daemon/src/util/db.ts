import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export function openDatabase(file: string, options: { nofollow?: boolean; timeout?: number; readOnly?: boolean } = {}): DatabaseSync {
  if (options.nofollow ?? true) {
    try {
      if (lstatSync(file).isSymbolicLink()) throw new Error(`unable to open database file: ${file} is a symbolic link`);
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  const database = new DatabaseSync(file, { timeout: options.timeout ?? 5000, readOnly: options.readOnly ?? false });
  return database;
}

export function transaction<T>(database: DatabaseSync, behavior: 'IMMEDIATE' | 'DEFERRED' | 'EXCLUSIVE', operation: () => T): T {
  database.exec(`BEGIN ${behavior}`);
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function withDatabase<T>(database: DatabaseSync, operation: (database: DatabaseSync) => T): T {
  try { return operation(database); } finally { try { database.close(); } catch {} }
}

export function blob(value: unknown): Buffer | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value);
  return undefined;
}
