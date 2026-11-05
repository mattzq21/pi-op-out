import { join } from 'node:path';
import { STORAGE_DIRECTORY } from '../config';
import { homeDir } from '../environment';
import { connection, transaction } from '../util/db';
import type { ToolConfig } from '../settings_types';
import { reported } from '../pi';

const changeListeners = new Set<() => void>();

function defaultRoot(): string { return join(homeDir(), STORAGE_DIRECTORY); }

function toolEntry(value: any): ToolConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A reported tool must be an object');
  for (const field of ['name', 'description', 'source'] as const) {
    if (typeof value[field] !== 'string') throw new Error('A reported tool has no ' + field);
  }
  if (!value.name) throw new Error('A reported tool has an empty name');
  return { name: value.name, description: value.description, source: value.source };
}

export function parseTools(value: unknown): ToolConfig[] {
  if (!Array.isArray(value)) throw new Error('Reported tools must be a list');
  const tools = value.map(toolEntry).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (let index = 1; index < tools.length; index += 1) {
    if (tools[index]!.name === tools[index - 1]!.name) throw new Error('Pi reported the tool ' + tools[index]!.name + ' twice');
  }
  return tools;
}

// The tools that Pi last reported in the storage root.
export function savedTools(root = defaultRoot()): ToolConfig[] {
  const row = connection(root).prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get() as { entries_json: string } | undefined;
  return parseTools(row ? JSON.parse(row.entries_json) : []);
}

// Saves the tools that Pi reported. True when they changed.
function saveTools(root: string, tools: ToolConfig[]): boolean {
  const entries = JSON.stringify(tools);
  const database = connection(root);
  return transaction(database, 'IMMEDIATE', () => {
    const row = database.prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get() as { entries_json: string } | undefined;
    if (row?.entries_json === entries) return false;
    database.prepare('INSERT INTO tool_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
    return true;
  });
}

export function recordTools(value: unknown, root = defaultRoot()): void {
  const tools = parseTools(value);
  const changed = saveTools(root, tools);
  reported('tools');
  if (changed) for (const listener of changeListeners) listener();
}

export function onToolsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
