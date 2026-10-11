import { realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { MAX_PATH_LIST_BYTES, MAX_SESSION_INDEX_BATCH_BYTES, STORAGE_DIRECTORY } from './config';
import { MAX_REMOTE_HOSTS } from './settings_types';
import { homeDir } from './environment';
import { sessionIdentity, ssh } from './pi_launch';
import { desktopSessionsDir, runLimited, shellQuote, type CommandSpec } from './process_io';
import { hostScript, runHostScript } from './host_script';
import { loadAppSettings } from './settings';
import * as restoreRecovery from './restore_recovery';
import * as storageTransactions from './storage_transactions';
import { hostFor } from './host_connection';
import { MutationGuard } from './conversation_ownership';
import * as sessionGroups from './session_groups';
import * as terminalLookup from './terminal_lookup';
import { stopTerminals } from './terminals';
import type { AppSettings, RemoteHost } from './settings_types';
import type { PiRuntime } from './pi_runtime';
import type { TerminalRuntime } from './terminals';
import type { App } from './app';

export interface HostStorage { hostId: string; hostName: string; categories: any[]; archives: any[]; warnings: string[]; error?: string }

type Inventory = { categories: any[]; archives: any[]; warnings: string[] };

const storageInventory = hostScript<Record<string, never>, Inventory>('storage-inventory', MAX_SESSION_INDEX_BATCH_BYTES, (value: any) => {
  if (!Array.isArray(value?.categories)) throw new Error('missing field `categories`');
  if (!Array.isArray(value?.archives)) throw new Error('missing field `archives`');
  return { categories: value.categories.map(normalizeCategory), archives: value.archives.map(normalizeArchive), warnings: Array.isArray(value.warnings) ? value.warnings : [] };
});

export async function inspectStorage(host: RemoteHost | undefined): Promise<HostStorage> {
  if (!host) await restoreRecovery.recover(join(homeDir(), STORAGE_DIRECTORY));
  else await restoreRecovery.recoverRemote(host);
  const label = host?.name ?? 'Local';
  let inventory: Inventory;
  try { inventory = await runHostScript(host ? { kind: 'remote', host } : { kind: 'local' }, storageInventory, {}); }
  catch (error: any) { throw new Error(`Could not inspect storage on ${label}: ${error?.message ?? error}`); }
  return { hostId: host?.id ?? 'local', hostName: label, ...inventory };
}

function normalizeCategory(category: any): any {
  if (!category || typeof category !== 'object') throw new Error('invalid type: expected struct StorageCategory');
  return { ...category, directories: Array.isArray(category.directories) ? category.directories : [], estimated: category.estimated === true };
}

function normalizeArchive(archive: any): any {
  if (!archive || typeof archive !== 'object') throw new Error('invalid type: expected struct ArchivedConversation');
  return { ...archive, restorable: archive.restorable === true };
}

export function failedStorage(hostId: string, hostName: string, error: string): HostStorage {
  return { hostId, hostName, categories: [], archives: [], warnings: [], error };
}

export async function storageReport(app: App): Promise<{ hosts: HostStorage[] }> {
  const local = await inspectStorage(undefined).catch((error: any) => failedStorage('local', 'Local', error?.message ?? String(error)));
  const remoteHosts = (await loadAppSettings(app)).hosts;
  const queue = remoteHosts.filter(host => host.enabled);
  const remote: HostStorage[] = [];
  await Promise.all(Array.from({ length: Math.min(MAX_REMOTE_HOSTS, 4, queue.length) }, async () => {
    for (;;) {
      const host = queue.pop();
      if (!host) return;
      remote.push(await inspectStorage(host).catch((error: any) => failedStorage(host.id, host.name, error?.message ?? String(error))));
    }
  }));
  remote.sort((left, right) => { const a = left.hostName.toLowerCase(); const b = right.hostName.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; });
  return { hosts: [local, ...remote] };
}

function within(path: string, root: string): boolean { return path.startsWith(root.endsWith(sep) ? root : root + sep) || path === root; }

function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }

export function localDesktopSessionFileAt(home: string, sessionPath: string): string {
  let root: string; let source: string;
  try { root = realpathSync(desktopSessionsDir(home)); } catch (error: any) { throw new Error(`Could not locate piop sessions: ${error.message}`); }
  try { source = realpathSync(sessionPath); } catch (error: any) { throw new Error(`Could not locate session file: ${error.message}`); }
  if (!within(source, root) || extname(source) !== '.jsonl' || !isFile(source)) throw new Error('Only piop session files can be accessed');
  return source;
}

export function localArchivedSessionFileAt(home: string, sessionPath: string): string {
  let root: string; let source: string;
  try { root = realpathSync(join(home, STORAGE_DIRECTORY, 'archived')); } catch (error: any) { throw new Error(`Could not locate piop archives: ${error.message}`); }
  try { source = realpathSync(sessionPath); } catch (error: any) { throw new Error(`Could not locate archived conversation: ${error.message}`); }
  if (!within(source, root) || extname(source) !== '.jsonl' || !isFile(source)) throw new Error('Only archived piop conversations can be accessed');
  return source;
}

export async function desktopSessionFile(settings: AppSettings, hostId: string, path: string): Promise<string> {
  return locateSessionFile(settings, hostId, path, false);
}

export async function archivedSessionFile(settings: AppSettings, hostId: string, path: string): Promise<string> {
  return locateSessionFile(settings, hostId, path, true);
}

async function locateSessionFile(settings: AppSettings, hostId: string, path: string, archived: boolean): Promise<string> {
  const host = hostFor(settings, hostId);
  const locate = async () => host.kind === 'local'
    ? (archived ? localArchivedSessionFileAt : localDesktopSessionFileAt)(homeDir(), path)
    : remoteSessionFile(path, archived, script => ssh(host.host, script));
  try { return await locate(); }
  catch {
    await storageTransactions.recover(host, { busyIsOk: true });
    return locate();
  }
}

export async function remoteSessionFile(path: string, archived: boolean, command: (script: string) => CommandSpec): Promise<string> {
  const [area, context, rejected] = archived
    ? ['archived', 'Could not locate archived Piop conversation', 'Only archived conversation files in this Piop profile can be deleted']
    : ['sessions', 'Could not locate Piop session', 'Only session files in this Piop profile can be opened'];
  const script = `root=$(cd "$HOME/${STORAGE_DIRECTORY}/${area}" && pwd -P) && session=$(realpath -- ${shellQuote(path)}) && [ -f "$session" ] && case "$session" in "$root"/*.jsonl) printf '%s' "$session" ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac`;
  const result = await runLimited(command(script), MAX_PATH_LIST_BYTES, context);
  if (!result.status.success) throw new Error(rejected);
  return result.stdout.toString('utf8');
}

async function retireArchivedSession(app: App, client: PiRuntime, hostId: string, sessionPath: string): Promise<void> {
  const connection = client.connections.get(hostId);
  if (!connection) return;
  const settings = await loadAppSettings(app);
  const path = await desktopSessionFile(settings, hostId, sessionPath);
  const key = await sessionIdentity(settings, hostId, path);
  if (connection.alive) await connection.request({ type: 'retire', sessionKey: key, sessionPath: path, archive: true });
}

async function releaseAll(guards: MutationGuard[]): Promise<void> { for (const guard of guards) await guard.release(); }

async function archiveSessionPaths(app: App, client: PiRuntime, hostId: string, sessionPath: string, clientId: string, mutations: MutationGuard[]): Promise<string[]> {
  mutations.push(await MutationGuard.acquire(app, hostId, sessionPath, clientId, false, 'archive'));
  await retireArchivedSession(app, client, hostId, sessionPath);
  const paths = [sessionPath];
  for (;;) {
    const descendants = (await sessionDescendants(app, hostId, sessionPath, false, false)).map(([path]) => path).filter(path => !paths.includes(path));
    if (!descendants.length) break;
    for (const path of descendants) {
      mutations.push(await MutationGuard.acquire(app, hostId, path, clientId, false, 'archive'));
      await retireArchivedSession(app, client, hostId, path);
      paths.push(path);
    }
  }
  return paths;
}

export async function archiveSession(app: App, runtime: TerminalRuntime, sessionPath: string, hostIdOption: string | undefined | null, terminalIds: string[], clientId: string): Promise<void> {
  const hostId = hostIdOption ?? 'local';
  const client = app.pi;
  await client.lifecycle.run(async () => {
    const settings = await loadAppSettings(app);
    const mutations: MutationGuard[] = [];
    try {
      const paths = await archiveSessionPaths(app, client, hostId, sessionPath, clientId, mutations);
      const sessionIds: string[] = [];
      for (const path of paths) sessionIds.push(await sessionIdentity(settings, hostId, path));
      terminalIds.push(...terminalLookup.sessionTerminals(runtime, hostId, sessionIds));
      await stopTerminals(runtime, terminalIds);
      const invalidate = app.sessionIndex.projects.invalidateAfter(hostId);
      try { await storageTransactions.archive(hostFor(settings, hostId), paths); }
      finally { invalidate(); }
      for (let index = 0; index < paths.length; index++) {
        await mutations[index]!.finish();
        app.emit('pi://session-removed', { hostId, sessionPath: paths[index], sessionId: sessionIds[index] });
      }
    } finally { await releaseAll(mutations); }
  });
}

type DescendantsRequest = { path: string; root: string | null; archived: boolean; includeOtherArea: boolean };

const descendantsScript = hostScript<DescendantsRequest, unknown[]>('session-descendants', MAX_SESSION_INDEX_BATCH_BYTES, value => {
  if (!Array.isArray(value)) throw new Error('expected a sequence');
  return value;
});

async function sessionDescendants(app: App, hostId: string, sessionPath: string, archived: boolean, includeOtherArea: boolean): Promise<Array<[string, boolean]>> {
  const settings = await loadAppSettings(app);
  const root = hostId === 'local' ? join(homeDir(), STORAGE_DIRECTORY, archived ? 'archived' : 'sessions') : null;
  let value: unknown[];
  try { value = await runHostScript(hostFor(settings, hostId), descendantsScript, { path: sessionPath, root, archived, includeOtherArea }); }
  catch (error: any) { throw new Error(`Could not find subagent conversations: ${error?.message ?? error}`); }
  if (includeOtherArea) return value.map((item: any) => {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'boolean') throw new Error('Invalid subagent conversation list: expected a tuple');
    return [item[0], item[1]];
  });
  return value.map((path: any) => { if (typeof path !== 'string') throw new Error('Invalid subagent conversation list: expected a string'); return [path, archived]; });
}

function storedSessionFile(settings: AppSettings, hostId: string, sessionPath: string, archived: boolean): Promise<string> {
  return archived ? archivedSessionFile(settings, hostId, sessionPath) : desktopSessionFile(settings, hostId, sessionPath);
}

async function deletionTargets(settings: AppSettings, hostId: string, paths: Array<[string, boolean]>): Promise<storageTransactions.DeletionTarget[]> {
  const targets: storageTransactions.DeletionTarget[] = [];
  for (const [path, archived] of paths) {
    const file = await storedSessionFile(settings, hostId, path, archived);
    targets.push({ path: file, area: archived ? 'archived' : 'sessions' });
  }
  return targets;
}

async function deleteStoredSessions(app: App, runtime: PiRuntime, sessionPaths: string[], hostIdOption: string | undefined | null, archived: boolean, clientId: string): Promise<string[]> {
  return runtime.lifecycle.run(async () => {
    const hostId = hostIdOption ?? 'local';
    const settings = await loadAppSettings(app);
    if (!sessionPaths.length) throw new Error('Select at least one conversation to delete');
    const mutations: MutationGuard[] = [];
    try {
      const paths: Array<[string, boolean]> = [];
      for (const sessionPath of sessionPaths) {
        const path = await storedSessionFile(settings, hostId, sessionPath, archived);
        if (paths.some(([existing]) => existing === path)) continue;
        mutations.push(await MutationGuard.acquire(app, hostId, path, clientId, archived, 'delete'));
        paths.push([path, archived]);
      }
      const roots = [...paths];
      for (;;) {
        const children: Array<[string, boolean]> = [];
        for (const [path, isArchived] of roots) children.push(...await sessionDescendants(app, hostId, path, isArchived, true));
        let added = false;
        for (const [child, childArchived] of children) {
          if (paths.some(([path]) => path === child)) continue;
          mutations.push(await MutationGuard.acquire(app, hostId, child, clientId, childArchived, 'delete'));
          paths.push([child, childArchived]);
          added = true;
        }
        if (!added) break;
      }
      const targets = await deletionTargets(settings, hostId, paths);
      const sessionIds: string[] = [];
      for (const [path] of paths) sessionIds.push(await sessionIdentity(settings, hostId, path));
      await stopTerminals(app.terminals, terminalLookup.sessionTerminals(app.terminals, hostId, sessionIds));
      await deleteSessionTargets(runtime, targets, hostId, settings);
      for (let index = 0; index < paths.length; index++) {
        try { await mutations[index]!.finishCommitted(); }
        catch (error: any) { console.error(`Conversation deletion committed, but ownership cleanup failed for ${paths[index]![0]}: ${error.message ?? error}`); }
        app.emit('pi://session-removed', { hostId, sessionPath: paths[index]![0], sessionId: sessionIds[index] });
      }
      try { await sessionGroups.refreshDeletions(app, hostId); }
      catch (error: any) { console.error(`Committed deletion group cleanup will retry: ${error.message ?? error}`); }
      return paths.map(([path]) => path);
    } finally { await releaseAll(mutations); }
  });
}

async function deleteSessionTargets(runtime: PiRuntime, targets: storageTransactions.DeletionTarget[], hostId: string, settings: AppSettings): Promise<void> {
  const agents = [...runtime.activeAgents.values()];
  if (agents.some(agent => !agent.messageable && agent.hostId === hostId && targets.some(target => agent.sessionPath !== undefined && agent.sessionPath === target.path))) {
    throw new Error('Close the session before deleting it');
  }
  const activeSessionIds = agents.filter(agent => !agent.messageable && agent.hostId === hostId).map(agent => agent.sessionId).filter((id): id is string => id !== undefined);
  await storageTransactions.deleteSessions(hostFor(settings, hostId), targets, activeSessionIds);
}

export function deleteSession(app: App, runtime: PiRuntime, sessionPath: string, hostId: string | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [sessionPath], hostId, false, clientId);
}

export function deleteArchivedSession(app: App, runtime: PiRuntime, sessionPath: string, sessionPaths: string[] | undefined | null, hostId: string | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [...(sessionPaths ?? []), sessionPath], hostId, true, clientId);
}

export async function restoreArchivedSession(app: App, sessionPath: string, hostId: string | undefined | null, clientId: string): Promise<void> {
  await restoreArchivedSessionResult(app, sessionPath, hostId, clientId);
}

async function restoreResult(settings: AppSettings, hostId: string, path: string): Promise<any> {
  const result = await storageTransactions.committedRestore(hostFor(settings, hostId), path);
  if (result === null || result === undefined) throw new Error('No committed restoration is available');
  return result;
}

function restoredConversations(result: any): any[] { return Array.isArray(result?.sessions) ? result.sessions : [result]; }

async function performRestore(app: App, settings: AppSettings, hostId: string, sessionPath: string, clientId: string): Promise<any> {
  let path: string;
  try { path = await archivedSessionFile(settings, hostId, sessionPath); }
  catch (error) { return restoreResult(settings, hostId, sessionPath).catch(() => { throw error; }); }
  let parent: MutationGuard;
  try { parent = await MutationGuard.acquire(app, hostId, path, clientId, true, 'restore'); }
  catch (error) { return restoreResult(settings, hostId, path).catch(() => { throw error; }); }
  const mutations: Array<[string, MutationGuard]> = [[path, parent]];
  try {
    for (const [child] of await sessionDescendants(app, hostId, path, true, false)) {
      mutations.push([child, await MutationGuard.acquire(app, hostId, child, clientId, true, 'restore')]);
    }
    const paths = mutations.map(([source]) => source);
    let result: any;
    try { result = await storageTransactions.restore(hostFor(settings, hostId), paths); }
    catch (error) { result = await restoreResult(settings, hostId, path).catch(() => { throw error; }); }
    const restored = restoredConversations(result);
    const restoredPaths = mutations.map(([source]) => {
      const session = restored.find(session => session?.sourcePath === source) ?? (mutations.length === 1 ? result : undefined);
      if (typeof session?.sessionPath !== 'string') throw new Error('Restored session path missing');
      return session.sessionPath as string;
    });
    for (let index = 0; index < mutations.length; index++) {
      try { await mutations[index]![1].finishRestore(restoredPaths[index]!); }
      catch (error: any) { console.error(`Restore committed; could not acknowledge ownership release: ${error.message ?? error}`); }
    }
    return result;
  } finally { for (const [, guard] of mutations) await guard.release(); }
}

export async function restoreArchivedSessionResult(app: App, sessionPath: string, hostIdOption: string | undefined | null, clientId: string): Promise<any> {
  const hostId = hostIdOption ?? 'local';
  return app.pi.lifecycle.run(async () => {
    const settings = await loadAppSettings(app);
    const result = await performRestore(app, settings, hostId, sessionPath, clientId);
    for (const session of restoredConversations(result)) app.emit('pi://session-restored', { hostId, sessionId: session?.sessionId ?? null, sessionPath: session?.sessionPath ?? null });
    app.emit('pi://sessions-changed', {});
    return result;
  });
}

export async function relocateSession(app: App, sessionPath: string, cwd: string, hostIdOption: string | undefined | null, clientId: string): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const hostId = hostIdOption ?? 'local';
    const mutation = await MutationGuard.acquire(app, hostId, sessionPath, clientId, false, 'relocate');
    try {
      const settings = await loadAppSettings(app);
      try { await runHostScript(hostFor(settings, hostId), relocateScript, { sessionPath, cwd }); }
      catch (error: any) { throw new Error(`Could not relocate conversation: ${error?.message ?? error}`); }
      await mutation.finish();
    } finally { await mutation.release(); }
  });
}

const relocateScript = hostScript<{ sessionPath: string; cwd: string }, null>('relocate-session', 64 * 1024, () => null);

type Recovery = { cwd: string; recovery: unknown; warnings: string[] };

const recoverScript = hostScript<{ action: 'empty'; sessionPath: string }, Recovery>('recover-missing-session', 64 * 1024, (value: any) => {
  if (typeof value?.cwd !== 'string' || !Array.isArray(value.warnings) || !value.warnings.every((item: unknown) => typeof item === 'string')) throw new Error('expected a recovery record');
  return value;
});

export async function recoverMissingSession(app: App, sessionPath: string, hostIdOption: string | undefined | null, action: string, clientId: string): Promise<any> {
  if (action !== 'empty') throw new Error('Unknown recovery action');
  const hostId = hostIdOption ?? 'local';
  return app.pi.lifecycle.run(async () => {
    const settings = await loadAppSettings(app);
    const path = await desktopSessionFile(settings, hostId, sessionPath);
    const mutation = await MutationGuard.acquire(app, hostId, path, clientId, false, 'relocate');
    try {
      let value: Recovery;
      try { value = await runHostScript(hostFor(settings, hostId), recoverScript, { action: 'empty', sessionPath: path }); }
      catch (error: any) { throw new Error(`Could not recover the session directory: ${error?.message ?? error}`); }
      await mutation.finish();
      app.emit('pi://sessions-changed', null);
      return value;
    } finally { await mutation.release(); }
  });
}
