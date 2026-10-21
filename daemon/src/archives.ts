import { realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { sessionIdentity } from './pi_launch';
import { desktopSessionsDir } from './process_io';
import { DEFAULT_TIMEOUT, hostOperation, profileRoot, runHostOperation, STORAGE_TIMEOUT } from './host_operations';
import { loadAppSettings } from './settings';
import * as restoreRecovery from './restore_recovery';
import * as storageTransactions from './storage_transactions';
import { StorageTransactionError } from './storage_transactions';
import * as chatWorktrees from './chat_worktree_lifecycle';
import { requireLocal } from './host_connection';
import { assertRootRestore, restoreSessionTree } from './restore';
import { MutationGuard } from './conversation_ownership';
import * as sessionGroups from './session_groups';
import * as terminalSessions from './terminal_sessions';
import { stopTerminals } from './terminals';
import type { AppSettings } from './settings_types';
import type { PiRuntime } from './pi_runtime';
import type { TerminalRuntime } from './terminals';
import type { App } from './app';

export interface HostStorage { hostId: string; hostName: string; categories: any[]; archives: any[]; warnings: string[]; error?: string }

type Inventory = { categories: any[]; archives: any[]; warnings: string[] };

const storageInventory = hostOperation<{ profile: string }, Inventory>('storage-inventory', 'general', STORAGE_TIMEOUT, (value: any) => {
  if (!Array.isArray(value?.categories)) throw new Error('missing field `categories`');
  if (!Array.isArray(value?.archives)) throw new Error('missing field `archives`');
  return { categories: value.categories.map(normalizeCategory), archives: value.archives.map(normalizeArchive), warnings: Array.isArray(value.warnings) ? value.warnings : [] };
});

/** Reads the storage report of this machine. Other machines report through their Piop daemon. */
export async function inspectStorage(): Promise<HostStorage> {
  await restoreRecovery.recover(profileRoot());
  let inventory: Inventory;
  try { inventory = await runHostOperation(storageInventory, { profile: profileRoot() }); }
  catch (error: any) { throw new Error(`Could not inspect storage on Local: ${error?.message ?? error}`); }
  return { hostId: 'local', hostName: 'Local', ...inventory, warnings: [...inventory.warnings, ...chatWorktrees.pendingWarnings()] };
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

export async function desktopSessionFile(_settings: AppSettings, hostId: string, path: string): Promise<string> {
  requireLocal(hostId);
  return locateSessionFile(path, false);
}

export async function archivedSessionFile(_settings: AppSettings, hostId: string, path: string): Promise<string> {
  requireLocal(hostId);
  return locateSessionFile(path, true);
}

/** Returns the real path of a session file in the active or archived area of this machine. */
export async function locateSessionFile(path: string, archived: boolean): Promise<string> {
  const locate = () => (archived ? localArchivedSessionFileAt : localDesktopSessionFileAt)(homeDir(), path);
  try { return locate(); }
  catch {
    await storageTransactions.recover({ busyIsOk: true });
    return locate();
  }
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

/** True when a failed storage transaction may have changed storage, so Git steps must wait for recovery. */
function maybeCommitted(error: unknown): boolean { return error instanceof StorageTransactionError && error.state !== 'rolled-back'; }

function reportWarnings(app: App, hostId: string, warnings: string[]): void {
  if (!warnings.length) return;
  const line = warnings.join('\n');
  console.error(line);
  app.emit('pi://daemon-error', { hostId, line });
}

/** Undoes Git steps after a failed transcript step that changed nothing, keeping the first error. */
async function undoAfter(error: unknown, undo: () => Promise<void>): Promise<never> {
  if (maybeCommitted(error)) throw error;
  try { await undo(); }
  catch (cleanup: any) { throw new Error(`${(error as any)?.message ?? error}\nWorktree cleanup failed: ${cleanup?.message ?? cleanup}`); }
  throw error;
}

async function archiveSessionPaths(app: App, client: PiRuntime, hostId: string, sessionPath: string, clientId: string, mutations: MutationGuard[]): Promise<string[]> {
  mutations.push(await MutationGuard.acquire(app, hostId, sessionPath, clientId, false, 'archive'));
  await retireArchivedSession(app, client, hostId, sessionPath);
  const paths = [sessionPath];
  requireLocal(hostId);
  for (;;) {
    const descendants = (await sessionDescendants(sessionPath, false, false)).map(([path]) => path).filter(path => !paths.includes(path));
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
      terminalIds.push(...terminalSessions.sessionTerminals(runtime, hostId, sessionIds));
      await stopTerminals(runtime, terminalIds);
      const archiving = await chatWorktrees.beginArchive(sessionIds);
      const invalidate = app.sessionIndex.projects.invalidateAfter(hostId);
      try { await storageTransactions.archive(paths); }
      catch (error) { chatWorktrees.stopped(archiving); await undoAfter(error, () => chatWorktrees.rollbackArchive(archiving)); }
      finally { invalidate(); }
      const warnings = await chatWorktrees.finishArchive(archiving);
      for (let index = 0; index < paths.length; index++) {
        try { await mutations[index]!.finishCommitted(); }
        catch (error: any) { warnings.push(`Archive committed, but ownership cleanup failed for ${paths[index]}: ${error?.message ?? error}`); }
        app.emit('pi://session-removed', { hostId, sessionPath: paths[index], sessionId: sessionIds[index] });
      }
      reportWarnings(app, hostId, warnings);
    } finally { await releaseAll(mutations); }
  });
}

type DescendantsRequest = { path: string; root: string; archived: boolean; includeOtherArea: boolean };

const descendantsOperation = hostOperation<DescendantsRequest, unknown[]>('session-descendants', 'general', STORAGE_TIMEOUT, value => {
  if (!Array.isArray(value)) throw new Error('expected a sequence');
  return value;
});

/** Returns the subagent sessions of the session at sessionPath. With includeOtherArea, each item also tells if it is archived. */
export async function sessionDescendants(sessionPath: string, archived: boolean, includeOtherArea: boolean): Promise<Array<[string, boolean]>> {
  const root = join(profileRoot(), archived ? 'archived' : 'sessions');
  let value: unknown[];
  try { value = await runHostOperation(descendantsOperation, { path: sessionPath, root, archived, includeOtherArea }); }
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
        for (const [path, isArchived] of roots) children.push(...await sessionDescendants(path, isArchived, true));
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
      await stopTerminals(app.terminals, terminalSessions.sessionTerminals(app.terminals, hostId, sessionIds));
      await deleteSessionTargets(targets, hostId);
      reportWarnings(app, hostId, await chatWorktrees.releaseDeleted(sessionIds));
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

async function deleteSessionTargets(targets: storageTransactions.DeletionTarget[], hostId: string): Promise<void> {
  requireLocal(hostId);
  await storageTransactions.deleteSessions(targets, []);
}

export function deleteSession(app: App, runtime: PiRuntime, sessionPath: string, hostId: string | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [sessionPath], hostId, false, clientId);
}

export function deleteArchivedSession(app: App, runtime: PiRuntime, sessionPath: string, sessionPaths: string[] | undefined | null, hostId: string | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [...(sessionPaths ?? []), sessionPath], hostId, true, clientId);
}

const restores = new Map<string, Promise<void>>();

/**
 * Restores an archived chat tree: first its Piop worktrees, then its transcripts in one storage transaction that also
 * points them at a moved worktree folder. The chats return to the active list unopened. Concurrent requests for the same
 * chat share one restore; a later repeat returns the saved restore receipt.
 */
export function restoreArchivedSession(app: App, sessionPath: string, hostIdOption: string | undefined | null, clientId: string): Promise<void> {
  const hostId = hostIdOption ?? 'local';
  const key = hostId + '\0' + sessionPath;
  const running = restores.get(key);
  if (running) return running;
  const restore = app.pi.lifecycle.run(() => restoreTree(app, hostId, sessionPath, clientId)).finally(() => restores.delete(key));
  restores.set(key, restore);
  return restore;
}

async function restoreTree(app: App, hostId: string, sessionPath: string, clientId: string): Promise<void> {
  requireLocal(hostId);
  const restoring = await beginTreeRestore(app, hostId, sessionPath);
  let result: Awaited<ReturnType<typeof restoreSessionTree>>;
  try { result = await restoreSessionTree(sessionPath, path => MutationGuard.acquire(app, hostId, path, clientId, true, 'restore'), chatWorktrees.folderMoves(restoring)); }
  catch (error) { chatWorktrees.stopped(restoring); return undoAfter(error, () => chatWorktrees.rollbackRestore(restoring)); }
  try { await chatWorktrees.finishRestore(restoring); }
  catch (error: any) { reportWarnings(app, hostId, [`Restore committed; releasing the archive reference will retry: ${error?.message ?? error}`]); }
  for (const session of result.sessions) app.emit('pi://session-restored', { hostId, sessionId: session.sessionId, sessionPath: session.sessionPath });
  app.emit('pi://sessions-changed', {});
}

/** Restores the worktrees of the archived tree at sessionPath. Returns none when the tree is no longer archived, so the restore receipt answers. */
async function beginTreeRestore(app: App, hostId: string, sessionPath: string): Promise<Awaited<ReturnType<typeof chatWorktrees.beginRestore>>> {
  let source: string;
  try { source = localArchivedSessionFileAt(homeDir(), sessionPath); }
  catch { return []; }
  assertRootRestore(source);
  const settings = await loadAppSettings(app);
  const tree = [source, ...(await sessionDescendants(source, true, false)).map(([path]) => path)];
  const chatIds: string[] = [];
  for (const path of tree) chatIds.push(await sessionIdentity(settings, hostId, path));
  return chatWorktrees.beginRestore(chatIds);
}

/**
 * Finishes or undoes chat worktree steps that a crash interrupted. Call once at daemon startup, before clients connect.
 * Records that still need recovery are logged and reported to clients; the daemon keeps running.
 */
export async function recoverChatWorktrees(app: App): Promise<void> {
  try { await app.pi.lifecycle.run(() => chatWorktrees.recover()); }
  catch (error: any) { reportWarnings(app, 'local', [error?.message ?? String(error)]); }
}

export async function relocateSession(app: App, sessionPath: string, cwd: string, hostIdOption: string | undefined | null, clientId: string): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const hostId = hostIdOption ?? 'local';
    const mutation = await MutationGuard.acquire(app, hostId, sessionPath, clientId, false, 'relocate');
    try {
      requireLocal(hostId);
      try { await runHostOperation(relocateOperation, { profile: profileRoot(), sessionPath, cwd }); }
      catch (error: any) { throw new Error(`Could not relocate conversation: ${error?.message ?? error}`); }
      await mutation.finish();
    } finally { await mutation.release(); }
  });
}

const relocateOperation = hostOperation<{ profile: string; sessionPath: string; cwd: string }, null>('relocate-session', 'general', DEFAULT_TIMEOUT, () => null);

type Recovery = { cwd: string; recovery: unknown; warnings: string[] };

const recoverOperation = hostOperation<{ action: 'empty'; profile: string; sessionPath: string }, Recovery>('recover-missing-session', 'general', DEFAULT_TIMEOUT, (value: any) => {
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
      try { value = await runHostOperation(recoverOperation, { action: 'empty', profile: profileRoot(), sessionPath: path }); }
      catch (error: any) { throw new Error(`Could not recover the session directory: ${error?.message ?? error}`); }
      await mutation.finish();
      app.emit('pi://sessions-changed', null);
      return value;
    } finally { await mutation.release(); }
  });
}
