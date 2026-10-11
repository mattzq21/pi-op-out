import { realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { MAX_PATH_LIST_BYTES, MAX_SESSION_INDEX_BATCH_BYTES, STORAGE_DIRECTORY } from './config';
import { MAX_REMOTE_HOSTS } from './settings_types';
import { homeDir } from './environment';
import { recoverMissingSessionBundle, relocateSessionBundle, sessionDescendantsBundle, storageInventoryBundle, storageTransactionBundle } from './resources';
import { nodeCommand } from './node_command';
import { remoteHost, remoteLoginCommand, sessionIdentity, ssh } from './pi_launch';
import { desktopSessionsDir, runLimited, shellQuote, type CommandSpec, type Output } from './process_io';
import { loadAppSettings } from './settings';
import * as restoreRecovery from './restore_recovery';
import * as Registry from './session_registry';
import { archiveConversations } from './archive_sessions';
import { MutationGuard } from './conversation_ownership';
import * as sessionGroups from './session_groups';
import * as terminalLookup from './terminal_lookup';
import { stopTerminals } from './terminals';
import type { AppSettings, RemoteHost } from './settings_types';
import type { PiRuntime } from './pi_runtime';
import type { TerminalRuntime } from './terminals';
import type { App } from './app';

export interface HostStorage { hostId: string; hostName: string; categories: any[]; archives: any[]; warnings: string[]; error?: string }

async function recoverHostTransactions(settings: AppSettings, hostId: string): Promise<void> {
  if (hostId === 'local') await restoreRecovery.recover(join(homeDir(), STORAGE_DIRECTORY));
  else await restoreRecovery.recoverRemote(remoteHost(settings, hostId));
}

async function transactionSettings(app: App, hostId: string): Promise<AppSettings> {
  const settings = await loadAppSettings(app);
  await recoverHostTransactions(settings, hostId);
  return settings;
}

export async function inspectStorage(host: RemoteHost | undefined): Promise<HostStorage> {
  if (!host) await restoreRecovery.recover(join(homeDir(), STORAGE_DIRECTORY));
  else await restoreRecovery.recoverRemote(host);
  const command = host
    ? ssh(host, remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(storageInventoryBundle)}`))
    : nodeCommand(['-e', storageInventoryBundle]);
  const label = host?.name ?? 'Local';
  const result = await runLimited(command, MAX_SESSION_INDEX_BATCH_BYTES, `Could not inspect storage on ${label}`);
  return parseStorageInventory(result, host);
}

function normalizeCategory(category: any): any {
  if (!category || typeof category !== 'object') throw new Error('invalid type: expected struct StorageCategory');
  return { ...category, directories: Array.isArray(category.directories) ? category.directories : [], estimated: category.estimated === true };
}

function normalizeArchive(archive: any): any {
  if (!archive || typeof archive !== 'object') throw new Error('invalid type: expected struct ArchivedConversation');
  return { ...archive, restorable: archive.restorable === true };
}

export function parseStorageInventory(result: Output, host: RemoteHost | undefined): HostStorage {
  const label = host?.name ?? 'Local';
  if (!result.status.success) {
    const error = result.stderr.toString().trim();
    throw new Error(error || `Could not inspect storage on ${label}`);
  }
  let inventory: any;
  try {
    inventory = JSON.parse(result.stdout.toString('utf8'));
    if (!Array.isArray(inventory?.categories)) throw new Error('missing field `categories`');
    if (!Array.isArray(inventory?.archives)) throw new Error('missing field `archives`');
  } catch (error: any) { throw new Error(`Could not read storage inventory from ${label}: ${error.message}`); }
  return { hostId: host?.id ?? 'local', hostName: label, categories: inventory.categories.map(normalizeCategory), archives: inventory.archives.map(normalizeArchive), warnings: Array.isArray(inventory.warnings) ? inventory.warnings : [] };
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
  if (hostId === 'local') return localDesktopSessionFileAt(homeDir(), path);
  const host = remoteHost(settings, hostId);
  return remoteSessionFile(path, false, script => ssh(host, script));
}

export async function archivedSessionFile(settings: AppSettings, hostId: string, path: string): Promise<string> {
  if (hostId === 'local') return localArchivedSessionFileAt(homeDir(), path);
  const host = remoteHost(settings, hostId);
  return remoteSessionFile(path, true, script => ssh(host, script));
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
    const settings = await transactionSettings(app, hostId);
    const mutations: MutationGuard[] = [];
    try {
      const paths = await archiveSessionPaths(app, client, hostId, sessionPath, clientId, mutations);
      const sessionIds: string[] = [];
      for (const path of paths) sessionIds.push(await sessionIdentity(settings, hostId, path));
      terminalIds.push(...terminalLookup.sessionTerminals(runtime, hostId, sessionIds));
      await stopTerminals(runtime, terminalIds);
      await archiveConversations(app, hostId, paths);
      for (let index = 0; index < paths.length; index++) {
        await mutations[index]!.finish();
        app.emit('pi://session-removed', { hostId, sessionPath: paths[index], sessionId: sessionIds[index] });
      }
    } finally { await releaseAll(mutations); }
  });
}

async function sessionDescendants(app: App, hostId: string, sessionPath: string, archived: boolean, includeOtherArea: boolean): Promise<Array<[string, boolean]>> {
  const settings = await loadAppSettings(app);
  const root = hostId === 'local' ? sessionStoreRoot(archived) : null;
  const argumentsText = JSON.stringify({ path: sessionPath, root, archived, includeOtherArea });
  const command = hostId === 'local'
    ? nodeCommand(['-e', sessionDescendantsBundle, argumentsText])
    : ssh(remoteHost(settings, hostId), remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(sessionDescendantsBundle)} ${shellQuote(argumentsText)}`));
  const result = await runLimited(command, MAX_SESSION_INDEX_BATCH_BYTES, 'Could not find subagent conversations');
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  let value: any;
  try { value = JSON.parse(result.stdout.toString('utf8')); } catch (error: any) { throw new Error(`Invalid subagent conversation list: ${error.message}`); }
  if (!Array.isArray(value)) throw new Error('Invalid subagent conversation list: expected a sequence');
  if (includeOtherArea) return value.map((item: any) => {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'boolean') throw new Error('Invalid subagent conversation list: expected a tuple');
    return [item[0], item[1]];
  });
  return value.map((path: any) => { if (typeof path !== 'string') throw new Error('Invalid subagent conversation list: expected a string'); return [path, archived]; });
}

function storedSessionFile(settings: AppSettings, hostId: string, sessionPath: string, archived: boolean): Promise<string> {
  return archived ? archivedSessionFile(settings, hostId, sessionPath) : desktopSessionFile(settings, hostId, sessionPath);
}

function sessionStoreRoot(archived: boolean): string {
  const home = homeDir();
  return archived ? join(home, STORAGE_DIRECTORY, 'archived') : desktopSessionsDir(home);
}

async function deletionTargets(settings: AppSettings, hostId: string, paths: Array<[string, boolean]>): Promise<any[]> {
  const targets: any[] = [];
  for (const [path, archived] of paths) {
    const file = await storedSessionFile(settings, hostId, path, archived);
    targets.push({ path: file, area: archived ? 'archived' : 'sessions', root: hostId === 'local' ? sessionStoreRoot(archived) : null });
  }
  return targets;
}

async function deleteStoredSessions(app: App, runtime: PiRuntime, sessionPaths: string[], hostIdOption: string | undefined | null, archived: boolean, clientId: string): Promise<string[]> {
  return runtime.lifecycle.run(async () => {
    const hostId = hostIdOption ?? 'local';
    const settings = await transactionSettings(app, hostId);
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
      const host = hostId === 'local' ? undefined : remoteHost(settings, hostId);
      const sessionIds: string[] = [];
      for (const [path] of paths) sessionIds.push(await sessionIdentity(settings, hostId, path));
      await stopTerminals(app.terminals, terminalLookup.sessionTerminals(app.terminals, hostId, sessionIds));
      await deleteSessionTargets(runtime, targets, hostId, host);
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

async function deleteSessionTargets(runtime: PiRuntime, targets: any[], hostId: string, host: RemoteHost | undefined): Promise<void> {
  const agents = [...runtime.activeAgents.values()];
  if (agents.some(agent => !agent.messageable && agent.hostId === hostId && targets.some(target => agent.sessionPath !== undefined && agent.sessionPath === target.path))) {
    throw new Error('Close the session before deleting it');
  }
  const activeSessionIds = agents.filter(agent => !agent.messageable && agent.hostId === hostId).map(agent => agent.sessionId).filter((id): id is string => id !== undefined);
  const argumentsText = JSON.stringify({ action: 'delete', targets, activeSessionIds });
  let command: CommandSpec;
  if (hostId === 'local') command = nodeCommand(['-e', storageTransactionBundle, argumentsText]);
  else {
    if (!host) throw new Error('Remote host is required');
    command = ssh(host, remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(storageTransactionBundle)} ${shellQuote(argumentsText)}`));
  }
  await runSessionDeletion(command);
}

export async function runSessionDeletion(command: CommandSpec): Promise<void> {
  const result = await runLimited(command, 256 * 1024, 'Could not delete session');
  if (result.status.success) { if (result.stderr.length) console.error(result.stderr.toString().trim()); return; }
  throw new Error(result.stderr.toString().trim() || 'Could not delete session');
}

export function deleteSession(app: App, runtime: PiRuntime, sessionPath: string, hostId: string | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [sessionPath], hostId, false, clientId);
}

export function deleteArchivedSession(app: App, runtime: PiRuntime, sessionPath: string, sessionPaths: string[] | undefined | null, hostId: string | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [...(sessionPaths ?? []), sessionPath], hostId, true, clientId);
}

function restoreSessionCommand(settings: AppSettings, hostId: string, request: unknown): CommandSpec {
  const text = JSON.stringify(request);
  if (hostId === 'local') return nodeCommand(['-e', storageTransactionBundle, text]);
  return ssh(remoteHost(settings, hostId), remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(storageTransactionBundle)} ${shellQuote(text)}`));
}

export async function restoreArchivedSession(app: App, sessionPath: string, hostId: string | undefined | null, clientId: string): Promise<void> {
  await restoreArchivedSessionResult(app, sessionPath, hostId, clientId);
}

async function restoreResult(settings: AppSettings, hostId: string, path: string): Promise<any> {
  const result = await runSessionRestoration(restoreSessionCommand(settings, hostId, { action: 'result', path }));
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
    try { result = await runSessionRestoration(restoreSessionCommand(settings, hostId, { action: 'restore', paths })); }
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
    const settings = await transactionSettings(app, hostId);
    const result = await performRestore(app, settings, hostId, sessionPath, clientId);
    for (const session of restoredConversations(result)) app.emit('pi://session-restored', { hostId, sessionId: session?.sessionId ?? null, sessionPath: session?.sessionPath ?? null });
    app.emit('pi://sessions-changed', {});
    return result;
  });
}

async function runSessionRestoration(command: CommandSpec): Promise<any> {
  const result = await runLimited(command, MAX_SESSION_INDEX_BATCH_BYTES, 'Could not restore archived chat');
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  if (result.stderr.length) console.error(result.stderr.toString().trim());
  let response: any;
  try { response = JSON.parse(result.stdout.toString('utf8')); } catch (error: any) { throw new Error(`Invalid chat restoration response: ${error.message}`); }
  return response?.result ?? null;
}

export async function relocateSession(app: App, sessionPath: string, cwd: string, hostIdOption: string | undefined | null, clientId: string): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const hostId = hostIdOption ?? 'local';
    const mutation = await MutationGuard.acquire(app, hostId, sessionPath, clientId, false, 'relocate');
    try {
      if (hostId !== 'local') {
        const settings = await loadAppSettings(app); const host = remoteHost(settings, hostId);
        await relocateRemoteSession(sessionPath, cwd, host.name, script => ssh(host, remoteLoginCommand(script)));
      } else await relocateLocalSession(homeDir(), sessionPath, cwd);
      await mutation.finish();
    } finally { await mutation.release(); }
  });
}

export async function recoverMissingSession(app: App, sessionPath: string, hostIdOption: string | undefined | null, action: string, clientId: string): Promise<any> {
  if (action !== 'empty') throw new Error('Unknown recovery action');
  const hostId = hostIdOption ?? 'local';
  return app.pi.lifecycle.run(async () => {
    const settings = await loadAppSettings(app);
    const path = await desktopSessionFile(settings, hostId, sessionPath);
    const mutation = await MutationGuard.acquire(app, hostId, path, clientId, false, 'relocate');
    try {
      const argumentsText = JSON.stringify({ sessionPath: path, action, storage: STORAGE_DIRECTORY });
      const registry = Registry.source();
      const command = hostId === 'local'
        ? nodeCommand(['-e', recoverMissingSessionBundle, argumentsText, relocateSessionBundle, registry])
        : ssh(remoteHost(settings, hostId), remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(recoverMissingSessionBundle)} ${shellQuote(argumentsText)} ${shellQuote(relocateSessionBundle)} ${shellQuote(registry)}`));
      const result = await runLimited(command, 64 * 1024, 'Could not recover the session directory');
      if (!result.status.success) throw new Error(result.stderr.toString().trim());
      let value: any;
      try { value = JSON.parse(result.stdout.toString('utf8')); } catch (error: any) { throw new Error(`Invalid recovery response: ${error.message}`); }
      await mutation.finish();
      app.emit('pi://sessions-changed', null);
      return value;
    } finally { await mutation.release(); }
  });
}

export async function relocateRemoteSession(sessionPath: string, cwd: string, hostName: string, command: (script: string) => CommandSpec): Promise<void> {
  const session = shellQuote(sessionPath); const replacement = shellQuote(cwd.trim());
  const relocate = shellQuote(relocateSessionBundle);
  const script = `root=$(cd "$HOME/${STORAGE_DIRECTORY}/sessions" && pwd -P) || exit 1; path=$(realpath -- ${session}) || exit 1; case "$path" in "$root"/*.jsonl) ;; *) printf 'Refusing to relocate a non-desktop session file' >&2; exit 1 ;; esac; replacement=${replacement}; [ -d "$replacement" ] || { printf 'Project directory does not exist: %s' "$replacement" >&2; exit 1; }; PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${relocate} "$path" "$replacement"`;
  const result = await runLimited(command(script), 64 * 1024, `Could not relocate conversation on ${hostName}`);
  if (result.status.success) return;
  throw new Error(result.stderr.toString().trim() || `Could not relocate conversation on ${hostName}`);
}

export async function relocateLocalSession(home: string, sessionPath: string, cwd: string): Promise<void> {
  const replacement = cwd.trim();
  let directory = false;
  try { directory = statSync(replacement).isDirectory(); } catch {}
  if (!directory) throw new Error(`Project directory does not exist: ${replacement}`);
  const path = localDesktopSessionFileAt(home, sessionPath);
  const result = await runLimited(nodeCommand(['-e', relocateSessionBundle, path, replacement]), 64 * 1024, 'Could not relocate conversation');
  if (result.status.success) return;
  throw new Error(result.stderr.toString().trim() || 'Could not relocate conversation');
}
