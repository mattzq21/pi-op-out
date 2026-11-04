import { MAX_REMOTE_HOSTS, defaultSettings, parseAppSettings, serializeAppSettings, validateContextCaps, validateRemoteHost, type AppSettings } from './settings_types';
import { mergeDiscoveredSkills } from './skill_discovery';
import { savedTools } from './tool_inventory';
import { migrateKeybindings, validateKeybindings } from './keybindings';
import { lockSettings, settingsPath, settingsRevision, storageLock } from './settings_storage';
import * as records from './settings_records';
import * as synchronization from './settings_synchronization';
import type { App } from './app';
import type { PiRuntime } from './pi_runtime';
import { updateSettings } from './local_host';
import * as peers from './peers';

export { mergeDiscoveredSkills };

export async function loadAppSettings(app: App): Promise<AppSettings> {
  const path = await settingsPath();
  synchronization.start(app);
  const settings = readSettingsAt(path);
  mergeDiscoveredSkills(settings);
  return settings;
}

export function loadSettingsChange(app: App): Promise<any> { return synchronization.snapshot(app); }

export function readSettingsAt(path: string): AppSettings {
  const body = records.read(path);
  const settings = body ? parseAppSettings(JSON.parse(body.toString('utf8'))) : defaultSettings();
  validateHostIds(settings);
  settings.settingsRevision = settingsRevision(body);
  settings.tools = savedTools(path);
  migrateKeybindings(settings);
  if (settings.hosts.length > MAX_REMOTE_HOSTS) throw new Error(`Settings contain more than ${MAX_REMOTE_HOSTS} remote hosts`);
  return settings;
}

export async function saveAppSettings(app: App, settings: AppSettings): Promise<any> {
  settings.tools = savedTools(await settingsPath());
  const runtime = app.pi;
  const change = await saveSettingsWith(runtime, settings,
    () => settingsPath(),
    settings => updateSettings(app, settings));
  synchronization.changed(app);
  peers.invalidate(app);
  try { await synchronization.publishCurrent(app, change); }
  catch (error: any) { appendSynchronizationWarning(change, `Settings were saved; their notification will retry automatically: ${error.message ?? error}`); }
  if (typeof change.publication?.error === 'string') change.settings.settingsDurabilityError = change.publication.error;
  return change;
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

async function lockSettingsRevision(path: string, expected: string | undefined) {
  const lock = await lockSettings(path);
  try {
    const previous = readSettingsAt(path);
    if (expected === undefined || expected !== previous.settingsRevision) throw new Error('Settings changed in another window or client. Reload the latest settings before saving.');
  } catch (error) { lock.release(); throw error; }
  return lock;
}

export function settingsBody(settings: AppSettings): Buffer {
  const { tools: _tools, ...saved } = serializeAppSettings(settings);
  return Buffer.from(JSON.stringify(saved, null, 2));
}

export async function saveSettingsWith(
  runtime: PiRuntime, settings: AppSettings,
  path: () => Promise<string>,
  synchronize: (settings: AppSettings) => Promise<void>,
): Promise<any> {
  migrateKeybindings(settings);
  validateSettingsForSave(settings);
  return runtime.lifecycle.run(async () => {
    const file = await path();
    const storage = await storageLock(file);
    try {
      const revision = await lockSettingsRevision(file, settings.settingsRevision);
      let save: synchronization.Save;
      let publication: records.Publication;
      const warnings: string[] = [];
      let body: Buffer;
      try {
        settings.settingsRevision = undefined;
        body = settingsBody(settings);
        save = synchronization.Save.prepare(file, body);
        publication = save.publish(body, warnings);
        settings.settingsRevision = settingsRevision(body);
      } finally { revision.release(); }
      const change = save.change(settings);
      change.publication = publication;
      if (publication.error !== undefined) change.settings.settingsDurabilityError = publication.error;
      try { await synchronize(settings); } catch (error: any) { warnings.push(`Settings were saved, but runtime synchronization failed: ${error.message ?? error}`); }
      save.finish(change, warnings);
      change.warnings = warnings;
      return change;
    } finally { storage.release(); }
  });
}

function appendSynchronizationWarning(change: any, warning: string): void {
  change.synchronizationPending = true;
  if (Array.isArray(change.warnings)) change.warnings.push(warning);
}
