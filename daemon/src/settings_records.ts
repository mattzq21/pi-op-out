import { basename, dirname, join } from 'node:path';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import { blob, openDatabase, transaction, withDatabase, type Database } from './util/db';

export interface Publication { committed: boolean; durable: boolean; error?: string }

export function open(path: string): Database {
  const root = dirname(path);
  ensurePrivateDir(root);
  const file = join(root, 'sessions.sqlite');
  const database = openDatabase(file, { timeout: 10_000 });
  try {
    setPrivateFilePermissions(file);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB);`);
  } catch (error) { database.close(); throw error; }
  return database;
}

export function name(path: string): string {
  const key = basename(path);
  if (!key) throw new Error('Invalid settings record name');
  return key;
}

export function read(path: string): Buffer | undefined {
  return withDatabase(open(path), database => transaction(database, 'IMMEDIATE', () => {
    const row = database.prepare('SELECT body FROM application_settings WHERE name=?').get(name(path)) as { body: unknown } | undefined;
    return blob(row?.body);
  }));
}

export function publish(path: string, body: Buffer | string): Publication {
  withDatabase(open(path), database => {
    database.prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body')
      .run(name(path), typeof body === 'string' ? Buffer.from(body) : body);
  });
  return { committed: true, durable: true };
}

/** Deletes a record when its body still equals the expected value. Returns true when a row was removed. */
export function removeIfEqual(path: string, expected: Buffer | string): boolean {
  const wanted = typeof expected === 'string' ? Buffer.from(expected) : expected;
  return withDatabase(open(path), database => transaction(database, 'IMMEDIATE', () => {
    const row = database.prepare('SELECT body FROM application_settings WHERE name=?').get(name(path)) as { body: unknown } | undefined;
    const current = blob(row?.body);
    if (!current || !current.equals(wanted)) return false;
    database.prepare('DELETE FROM application_settings WHERE name=?').run(name(path));
    return true;
  }));
}

export function readOrCreate(path: string, initial: Buffer | string): Buffer {
  const initialBody = typeof initial === 'string' ? Buffer.from(initial) : initial;
  return withDatabase(open(path), database => transaction(database, 'IMMEDIATE', () => {
    const key = name(path);
    const row = database.prepare('SELECT body FROM application_settings WHERE name=?').get(key) as { body: unknown } | undefined;
    const saved = blob(row?.body);
    if (saved) return saved;
    database.prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(key, initialBody);
    return initialBody;
  }));
}

const TOOL_INVENTORY = 'CREATE TABLE IF NOT EXISTS tool_inventory (id INTEGER PRIMARY KEY CHECK (id = 1), entries_json TEXT NOT NULL)';

/** The tools that Pi last reported on this host, or an empty list before the first report. */
export function toolInventory(path: string): unknown[] {
  return withDatabase(open(path), database => {
    database.exec(TOOL_INVENTORY);
    const row = database.prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get() as { entries_json: string } | undefined;
    return row ? JSON.parse(row.entries_json) : [];
  });
}

/** Saves the reported tools. Returns whether they differ from the saved ones. */
export function saveToolInventory(path: string, tools: unknown[]): boolean {
  const entries = JSON.stringify(tools);
  return withDatabase(open(path), database => {
    database.exec(TOOL_INVENTORY);
    return transaction(database, 'IMMEDIATE', () => {
      const row = database.prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get() as { entries_json: string } | undefined;
      if (row?.entries_json === entries) return false;
      database.prepare('INSERT INTO tool_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
      return true;
    });
  });
}

const COMMAND_INVENTORY = 'CREATE TABLE IF NOT EXISTS command_inventory (id INTEGER PRIMARY KEY CHECK (id = 1), entries_json TEXT NOT NULL)';

/** The extension commands that Pi last reported on this host, or null before the first report. */
export function commandInventory(path: string): unknown[] | null {
  return withDatabase(open(path), database => {
    database.exec(COMMAND_INVENTORY);
    const row = database.prepare('SELECT entries_json FROM command_inventory WHERE id=1').get() as { entries_json: string } | undefined;
    return row ? JSON.parse(row.entries_json) : null;
  });
}

/** Saves the reported commands. */
export function saveCommandInventory(path: string, commands: unknown[]): void {
  const entries = JSON.stringify(commands);
  withDatabase(open(path), database => {
    database.exec(COMMAND_INVENTORY);
    database.prepare('INSERT INTO command_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
  });
}

export function skillInventory(path: string, root: string, refresh: boolean, discover: () => any[]): any[] {
  return withDatabase(open(path), database => {
    database.exec('CREATE TABLE IF NOT EXISTS skill_inventory (root TEXT PRIMARY KEY, entries_json TEXT NOT NULL)');
    return transaction(database, 'IMMEDIATE', () => {
      const row = database.prepare('SELECT entries_json FROM skill_inventory WHERE root=?').get(root) as { entries_json: string } | undefined;
      if (row && !refresh) return JSON.parse(row.entries_json);
      const skills = discover();
      database.prepare('INSERT INTO skill_inventory VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET entries_json=excluded.entries_json').run(root, JSON.stringify(skills));
      return skills;
    });
  });
}
