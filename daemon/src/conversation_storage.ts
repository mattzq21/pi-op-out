import * as Registry from './session_registry';
import { transaction, type Database } from './util/db';

function open(root: string): Database {
  const database = Registry.open(root);
  try { database.exec('CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT)'); }
  catch (error) { database.close(); throw error; }
  return database;
}

function validateKey(key: string): void {
  if (key.length !== 40 || !/^[0-9a-f]+$/.test(key)) throw new Error('Invalid conversation ownership key');
}

export function read(root: string, key: string): string | undefined {
  validateKey(key);
  const database = open(root);
  try {
    return transaction(database, 'IMMEDIATE', () => {
      const row = database.prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(key) as { record_json: string | null } | undefined;
      return row?.record_json ?? undefined;
    });
  } finally { database.close(); }
}

export function write(root: string, key: string, body: string): void {
  validateKey(key);
  const database = open(root);
  try { database.prepare('INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(key, body); }
  finally { database.close(); }
}

export function remove(root: string, key: string): void {
  validateKey(key);
  const database = open(root);
  try { database.prepare('DELETE FROM conversation_ownership WHERE record_id=?').run(key); } finally { database.close(); }
}
