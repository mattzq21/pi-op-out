import { MAX_REMOTE_HOSTS, codexWebSearchTool, defaultSettings, parseAppSettings, serializeAppSettings, sessionOperationTools, validateContextCaps, validateRemoteHost, type AppSettings } from './settings_types';
import { mergeDiscoveredSkills } from './skill_discovery';
import { migrateKeybindings, validateKeybindings } from './keybindings';
import { lockSettings, settingsPath, settingsRevision, storageLock } from './settings_storage';
import * as records from './settings_records';
import * as synchronization from './settings_synchronization';
import type { App } from './app';
import type { PiRuntime } from './pi_runtime';
import * as daemon from './daemon';
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

function migrateGoalTools(settings: AppSettings): void {
  settings.tools = settings.tools.filter(tool => tool?.name !== 'goal');
  for (const tool of sessionOperationTools().filter(tool => ['get_goal', 'create_goal', 'update_goal'].includes(tool.name))) {
    const existing = settings.tools.find(existing => existing?.name === tool.name);
    if (existing) existing.enabled = true; else settings.tools.push(tool);
  }
}

function initializeSessionTools(settings: AppSettings): void {
  for (const tool of sessionOperationTools()) if (!settings.tools.some(existing => existing?.name === tool.name)) settings.tools.push(tool);
}

function migrateBuiltinTools(settings: AppSettings): void {
  for (const [legacy, replacements] of [['exec_command', ['read', 'bash', 'grep', 'find', 'ls']], ['apply_patch', ['edit', 'write']]] as const) {
    const legacyTool = settings.tools.find(tool => typeof tool?.name === 'string' && tool.name === legacy);
    const enabled = typeof legacyTool?.enabled === 'boolean' ? legacyTool.enabled : true;
    settings.tools = settings.tools.filter(tool => !(typeof tool?.name === 'string' && tool.name === legacy));
    for (const name of replacements) {
      if (!settings.tools.some(tool => typeof tool?.name === 'string' && tool.name === name)) settings.tools.push({ name, description: 'Pi built-in tool', enabled, builtin: true });
    }
  }
  if (!settings.tools.some(tool => typeof tool?.name === 'string' && tool.name === 'web_search')) settings.tools.push(codexWebSearchTool());
}

export function readSettingsAt(path: string): AppSettings {
  const body = records.read(path);
  const settings = body ? parseAppSettings(JSON.parse(body.toString('utf8'))) : defaultSettings();
  validateHostIds(settings);
  settings.settingsRevision = settingsRevision(body);
  migrateGoalTools(settings);
  initializeSessionTools(settings);
  migrateBuiltinTools(settings);
  migrateKeybindings(settings);
  if (settings.hosts.length > MAX_REMOTE_HOSTS) throw new Error(`Settings contain more than ${MAX_REMOTE_HOSTS} remote machines`);
  return settings;
}

export async function saveAppSettings(app: App, settings: AppSettings, agentHostId: string | undefined): Promise<any> {
  migrateGoalTools(settings);
  for (const tool of sessionOperationTools()) if (!settings.tools.some(existing => existing?.name === tool.name)) settings.tools.push(tool);
  const runtime = app.pi;
  const change = await saveSettingsWith(runtime, settings, agentHostId,
    () => settingsPath(),
    settings => daemon.invalidateChanged(app, runtime, settings),
    settings => daemon.updateSettings(app, runtime, settings));
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
  if (settings.hosts.length > MAX_REMOTE_HOSTS) throw new Error(`At most ${MAX_REMOTE_HOSTS} remote machines can be configured`);
  const hostIds = new Set<string>();
  const hostNames = new Set(['local']);
  for (const host of settings.hosts) {
    if (!host.id.trim() || hostIds.has(host.id)) throw new Error('Every machine needs a unique id');
    hostIds.add(host.id);
    const name = host.name.trim().toLowerCase();
    if (!name) throw new Error('Every machine needs a name');
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
  return Buffer.from(JSON.stringify(serializeAppSettings(settings), null, 2));
}

export async function saveSettingsWith(
  runtime: PiRuntime, settings: AppSettings, agentHostId: string | undefined,
  path: () => Promise<string>,
  invalidate: (settings: AppSettings) => Promise<void>,
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
        save = synchronization.Save.prepare(file, body, agentHostId);
        publication = save.publish(body, warnings);
        settings.settingsRevision = settingsRevision(body);
      } finally { revision.release(); }
      const change = save.change(settings);
      change.publication = publication;
      if (publication.error !== undefined) change.settings.settingsDurabilityError = publication.error;
      save.restoreAgents(runtime, change, warnings);
      await applySavedSettings(settings, invalidate, synchronize, warnings);
      save.finish(change, warnings);
      change.warnings = warnings;
      return change;
    } finally { storage.release(); }
  });
}

async function applySavedSettings(settings: AppSettings, invalidate: (settings: AppSettings) => Promise<void>, synchronize: (settings: AppSettings) => Promise<void>, warnings: string[]): Promise<void> {
  try { await invalidate(settings); } catch (error: any) { warnings.push(`Settings were saved, but runtime invalidation failed: ${error.message ?? error}`); }
  try { await synchronize(settings); } catch (error: any) { warnings.push(`Settings were saved, but runtime synchronization failed: ${error.message ?? error}`); }
}

export function publishSavedAgentRevision(runtime: PiRuntime, hostId: string | undefined, revision: number, change: any, _warnings: string[]): void {
  if (hostId === undefined) return;
  runtime.agentConfigRevision = Math.max(runtime.agentConfigRevision, revision);
  runtime.agentConfigRevisions.set(hostId, revision);
  change.agentConfigChange = { hostId, revision };
}

function appendSynchronizationWarning(change: any, warning: string): void {
  change.synchronizationPending = true;
  if (Array.isArray(change.warnings)) change.warnings.push(warning);
}
