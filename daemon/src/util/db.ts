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
    if (!database.isTransaction) throw error;
    try { database.exec('ROLLBACK'); } catch (failure) { throw attachFailure(error, failure, 'rollback'); }
    throw error;
  }
}

export function withDatabase<T>(database: DatabaseSync, operation: (database: DatabaseSync) => T): T {
  let result: T;
  try { result = operation(database); }
  catch (error) {
    try { database.close(); } catch (failure) { throw attachFailure(error, failure, 'close'); }
    throw error;
  }
  database.close();
  return result;
}

function attachFailure(error: unknown, failure: unknown, step: 'rollback' | 'close'): unknown {
  const detail = failure instanceof Error ? failure.message : String(failure);
  if (!(error instanceof Error)) return new AggregateError([error, failure], `Database operation failed; ${step} also failed: ${detail}`);
  error.message += `; ${step} also failed: ${detail}`;
  Object.assign(error, { [`${step}Error`]: failure });
  return error;
}

export function blob(value: unknown): Buffer | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value);
  return undefined;
}
