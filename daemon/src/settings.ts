import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MAX_REMOTE_HOSTS, defaultSettings, parseAppSettings, serializeAppSettings, validateContextCaps, validateRemoteHost, type AppSettings } from './settings_types';
import { mergeDiscoveredSkills, onSkillsChanged, watchSkills } from './skill_discovery';
import { onToolsChanged, savedTools } from './tool_inventory';
import { validateKeybindings } from './keybindings';
import { createHash } from 'node:crypto';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir } from './private_fs';
import * as records from '../resources/application-records.cjs';
import type { App } from './app';
import { updateSettings } from './local_host';
import * as peers from './peers';
import { Mutex, errorText } from './util/sync';

export { mergeDiscoveredSkills };

// The daemon is the only writer of its settings, so it keeps them in memory. A save, or a change of the discovered
// skills or tools, replaces the copy and tells clients. Readers get their own copy.

interface State { settings: AppSettings; revision: number; phase: number; warnings: string[] }

// Identifies this daemon run. Clients compare revisions only between changes of the same run.
const SOURCE = randomUUID();

let state: State | undefined;
let watched: App | undefined;
const saves = new Mutex();

// The storage root of this daemon.
function storageRoot(): string {
  const directory = join(homeDir(), STORAGE_DIRECTORY);
  ensurePrivateDir(directory);
  return directory;
}

function settingsRevision(body: Buffer | undefined): string {
  return body ? createHash('sha256').update(body).digest('hex') : 'missing';
}

// The saved settings of the storage root.
export function readSettingsAt(root: string): AppSettings {
  const body = records.read(root, 'settings');
  const settings = body ? parseAppSettings(JSON.parse(body.toString('utf8'))) : defaultSettings();
  validateHostIds(settings);
  settings.settingsRevision = settingsRevision(body);
  settings.tools = savedTools(root);
  if (settings.hosts.length > MAX_REMOTE_HOSTS) throw new Error(`Settings contain more than ${MAX_REMOTE_HOSTS} remote hosts`);
  return settings;
}

function saved(): AppSettings {
  const settings = readSettingsAt(storageRoot());
  mergeDiscoveredSkills(settings);
  return settings;
}

function current(): State { return state ??= { settings: saved(), revision: 1, phase: 0, warnings: [] }; }

export async function loadAppSettings(app: App): Promise<AppSettings> {
  watch(app);
  return structuredClone(current().settings);
}

function change(value: State, extra: Record<string, unknown> = {}): any {
  return { settings: serializeAppSettings(value.settings), committed: true, revision: value.revision, source: SOURCE,
    synchronizationPending: value.warnings.length > 0, phaseRevision: value.phase, warnings: [...value.warnings], ...extra };
}

export async function loadSettingsChange(app: App): Promise<any> {
  watch(app);
  return change(current());
}

// Gives the settings to the running Pi runtimes and the local host. A failure is reported with the change.
async function apply(app: App, settings: AppSettings): Promise<string[]> {
  try { await updateSettings(app, settings); return []; }
  catch (error) { return [`Settings were saved, but runtime synchronization failed: ${errorText(error)}`]; }
}

function report(app: App, warnings: string[]): void {
  if (!warnings.length) return;
  const line = warnings.join('\n');
  console.error(line);
  app.emit('pi://daemon-error', { hostId: 'local', line });
}

// The discovered skills or tools changed: the settings that clients and runtimes see change with them. Readers see the
// new settings at once; the runtimes get them in turn with other settings changes.
function rediscover(app: App): void {
  const previous = current();
  const next = saved();
  if (JSON.stringify([next.skills, next.tools]) === JSON.stringify([previous.settings.skills, previous.settings.tools])) return;
  state = { settings: next, revision: previous.revision, phase: previous.phase + 1, warnings: [] };
  saves.run(() => app.pi.lifecycle.run(async () => {
    const latest = current();
    latest.warnings = await apply(app, latest.settings);
    report(app, latest.warnings);
    peers.invalidate(app);
    app.emit('pi://settings-changed', change(latest));
  })).catch(error => report(app, [`Could not give the discovered skills and tools to the runtimes: ${errorText(error)}`]));
}

function watch(app: App): void {
  if (watched) return;
  watched = app;
  const changed = () => {
    try { rediscover(app); } catch (error) { report(app, [`Could not refresh the discovered skills and tools: ${errorText(error)}`]); }
  };
  onSkillsChanged(changed);
  onToolsChanged(changed);
  watchSkills((error: any) => report(app, [`Skill changes are not watched: ${error?.message ?? error}`]));
}

export async function saveAppSettings(app: App, settings: AppSettings): Promise<any> {
  watch(app);
  validateSettingsForSave(settings);
  return saves.run(() => app.pi.lifecycle.run(async () => {
    const previous = current();
    if (settings.settingsRevision === undefined || settings.settingsRevision !== previous.settings.settingsRevision) throw new Error('Settings changed in another window or client. Reload the latest settings before saving.');
    const root = storageRoot();
    settings.tools = savedTools(root);
    settings.settingsRevision = undefined;
    records.save(root, 'settings', settingsBody(settings));
    const publication = { committed: true, durable: true };
    const next = saved();
    const warnings = await apply(app, next);
    state = { settings: next, revision: previous.revision + 1, phase: 0, warnings };
    report(app, warnings);
    peers.invalidate(app);
    const result = change(state, { committedRevision: state.revision, publication });
    app.emit('pi://settings-changed', change(state));
    return result;
  }));
}

function validateHostIds(settings: AppSettings): void {
  if (settings.hosts.some(host => host.id.trim().toLowerCase() === 'local')) throw new Error("Remote host id 'local' is reserved for the local host");
}

export function validateSettingsForSave(settings: AppSettings): void {
  validateContextCaps(settings);
  validateKeybindings(settings);
  validateHostIds(settings);
  if (settings.hosts.length > MAX_REMOTE_HOSTS) throw new Error(`At most ${MAX_REMOTE_HOSTS} remote hosts can be configured`);
  const hostIds = new Set<string>();
  const hostNames = new Set(['local']);
  for (const host of settings.hosts) {
    if (!host.id.trim() || hostIds.has(host.id)) throw new Error('Every host needs a unique id');
    hostIds.add(host.id);
    const name = host.name.trim().toLowerCase();
    if (!name) throw new Error('Every host needs a name');
    if (hostNames.has(name)) throw new Error(`Host name '${host.name.trim()}' is already in use`);
    hostNames.add(name);
    validateRemoteHost(host);
  }
}

function settingsBody(settings: AppSettings): Buffer {
  const { tools: _tools, ...saved } = serializeAppSettings(settings);
  return Buffer.from(JSON.stringify(saved, null, 2));
}
