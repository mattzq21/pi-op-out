import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import * as records from './settings_records';
import type { ToolConfig } from './settings_types';
import type { App } from './app';
import { startPiForOwner, stopPi } from './pi_runtime';

/**
 * The tools that Pi offers on this host. Each Pi session reports them when it starts, and the latest report is saved.
 * Tools that one agent adds, from its MCP servers or its own extensions, are not part of it.
 */

const DISCOVERY_TIMEOUT_MS = 60_000;
const changeListeners = new Set<() => void>();
const reportWaiters = new Set<() => void>();

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
  for (const waiter of [...reportWaiters]) waiter();
  if (changed) for (const listener of changeListeners) listener();
}

export function onToolsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

function nextReport(): { reported: Promise<void>; cancel: () => void } {
  let waiter!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const reported = new Promise<void>((resolve, reject) => {
    waiter = () => { cancel(); resolve(); };
    timer = setTimeout(() => { cancel(); reject(new Error('Pi did not report its tools within ' + DISCOVERY_TIMEOUT_MS / 1000 + ' seconds')); }, DISCOVERY_TIMEOUT_MS);
    reportWaiters.add(waiter);
  });
  const cancel = () => { clearTimeout(timer); reportWaiters.delete(waiter); };
  return { reported, cancel };
}

/** Starts a Pi session on this host without a chat, waits for its tool report, then stops it. */
export async function discoverTools(app: App): Promise<void> {
  const runtimeId = 'tool-discovery-' + randomUUID();
  const report = nextReport();
  try {
    await startPiForOwner(app, 'tool-discovery', app.pi, app.broker, { runtimeId, clientId: runtimeId, hostId: 'local', cwd: homeDir() });
    await report.reported;
  } finally {
    report.cancel();
    await stopPi(app.pi, runtimeId, true);
  }
}
