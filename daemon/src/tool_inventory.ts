import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import * as records from './settings_records';
import type { ToolConfig } from './settings_types';
import { reported } from './pi_discovery';

/**
 * The tools that Pi offers on this host. Each Pi session reports them when it starts, and the latest report is saved.
 * Tools that one agent adds, from its MCP servers or its own extensions, are not part of it.
 */

const changeListeners = new Set<() => void>();

function defaultSettingsFile(): string { return join(homeDir(), STORAGE_DIRECTORY, 'settings.json'); }

function toolEntry(value: any): ToolConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A reported tool must be an object');
  for (const field of ['name', 'description', 'source'] as const) {
    if (typeof value[field] !== 'string') throw new Error('A reported tool has no ' + field);
  }
  if (!value.name) throw new Error('A reported tool has an empty name');
  return { name: value.name, description: value.description, source: value.source };
}

/** Checks a report and orders it by name. A name may appear only once. */
export function parseTools(value: unknown): ToolConfig[] {
  if (!Array.isArray(value)) throw new Error('Reported tools must be a list');
  const tools = value.map(toolEntry).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (let index = 1; index < tools.length; index += 1) {
    if (tools[index]!.name === tools[index - 1]!.name) throw new Error('Pi reported the tool ' + tools[index]!.name + ' twice');
  }
  return tools;
}

/** The saved tools of this host, or an empty list before Pi reported them. settingsFile locates the host storage. */
export function savedTools(settingsFile = defaultSettingsFile()): ToolConfig[] {
  return parseTools(records.toolInventory(settingsFile));
}

/** Saves the tools that a Pi session reported, and tells the listeners when they changed. */
export function recordTools(value: unknown, settingsFile = defaultSettingsFile()): void {
  const tools = parseTools(value);
  const changed = records.saveToolInventory(settingsFile, tools);
  reported('tools');
  if (changed) for (const listener of changeListeners) listener();
}

export function onToolsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
