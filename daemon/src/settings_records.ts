import { basename, dirname } from 'node:path';
import { blob, connection, transaction, type Database } from './util/db';

export interface Publication { committed: boolean; durable: boolean; error?: string }

// The settings database row of a record path: the folder selects the storage root, the file name the row.
export function open(path: string): Database {
  return connection(dirname(path));
}

export function name(path: string): string {
  const key = basename(path);
  if (!key) throw new Error('Invalid settings record name');
  return key;
}

export function read(path: string): Buffer | undefined {
  const row = open(path).prepare('SELECT body FROM application_settings WHERE name=?').get(name(path)) as { body: unknown } | undefined;
  return blob(row?.body);
}

export function publish(path: string, body: Buffer | string): Publication {
  open(path).prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body')
    .run(name(path), typeof body === 'string' ? Buffer.from(body) : body);
  return { committed: true, durable: true };
}

export function removeIfEqual(path: string, expected: Buffer | string): boolean {
  const wanted = typeof expected === 'string' ? Buffer.from(expected) : expected;
  const database = open(path);
  return transaction(database, 'IMMEDIATE', () => {
    const row = database.prepare('SELECT body FROM application_settings WHERE name=?').get(name(path)) as { body: unknown } | undefined;
    const current = blob(row?.body);
    if (!current || !current.equals(wanted)) return false;
    database.prepare('DELETE FROM application_settings WHERE name=?').run(name(path));
    return true;
  });
}

export function readOrCreate(path: string, initial: Buffer | string): Buffer {
  const initialBody = typeof initial === 'string' ? Buffer.from(initial) : initial;
  const database = open(path);
  return transaction(database, 'IMMEDIATE', () => {
    const key = name(path);
    const row = database.prepare('SELECT body FROM application_settings WHERE name=?').get(key) as { body: unknown } | undefined;
    const saved = blob(row?.body);
    if (saved) return saved;
    database.prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(key, initialBody);
    return initialBody;
  });
}

export function toolInventory(path: string): unknown[] {
  const row = open(path).prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get() as { entries_json: string } | undefined;
  return row ? JSON.parse(row.entries_json) : [];
}

export function saveToolInventory(path: string, tools: unknown[]): boolean {
  const entries = JSON.stringify(tools);
  const database = open(path);
  return transaction(database, 'IMMEDIATE', () => {
    const row = database.prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get() as { entries_json: string } | undefined;
    if (row?.entries_json === entries) return false;
    database.prepare('INSERT INTO tool_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
    return true;
  });
}

export function commandInventory(path: string): unknown[] | null {
  const row = open(path).prepare('SELECT entries_json FROM command_inventory WHERE id=1').get() as { entries_json: string } | undefined;
  return row ? JSON.parse(row.entries_json) : null;
}

export function saveCommandInventory(path: string, commands: unknown[]): void {
  const entries = JSON.stringify(commands);
  open(path).prepare('INSERT INTO command_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
}

export function skillInventory(path: string, root: string, refresh: boolean, discover: () => any[]): any[] {
  const database = open(path);
  return transaction(database, 'IMMEDIATE', () => {
    const row = database.prepare('SELECT entries_json FROM skill_inventory WHERE root=?').get(root) as { entries_json: string } | undefined;
    if (row && !refresh) return JSON.parse(row.entries_json);
    const skills = discover();
    database.prepare('INSERT INTO skill_inventory VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET entries_json=excluded.entries_json').run(root, JSON.stringify(skills));
    return skills;
  });
}
