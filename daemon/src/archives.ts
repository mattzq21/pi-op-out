import { realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { z } from 'zod';
import { archivedConversationSchema, hostStorageSchema, storageCategorySchema } from '../../protocol/results';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { sessionIdentity } from './pi_launch';
import { desktopSessionsDir } from './process_io';
import { DEFAULT_TIMEOUT, hostOperation, profileRoot, runHostOperation, STORAGE_TIMEOUT } from './host_operations';
import * as storageTransactions from './storage_transactions';
import { StorageTransactionError } from './storage_transactions';
import * as chatWorktrees from './chat_worktree_lifecycle';
import { assertRootRestore, restoreSessionTree } from './restore';
import { MutationGuard } from './conversation_ownership';
import * as sessionGroups from './session_groups';
import * as terminalSessions from './terminal_sessions';
import { stopTerminals } from './terminals';
import type { PiRuntime } from './pi_runtime';
import type { TerminalRuntime } from './terminals';
import type { App } from './app';

export type HostStorage = z.output<typeof hostStorageSchema>;

const inventorySchema = z.object({
  categories: z.array(storageCategorySchema.extend({ directories: z.array(z.string()).default([]), estimated: z.boolean().default(false) })),
  archives: z.array(archivedConversationSchema), warnings: z.array(z.string()).default([]),
});

type Inventory = z.output<typeof inventorySchema>;

const storageInventory = hostOperation<{ profile: string; archivesOnly: boolean; archivesLimit?: number }, Inventory>('storage-inventory', 'general', STORAGE_TIMEOUT, inventorySchema);

export async function inspectStorage(archivesOnly = false, archivesLimit?: number): Promise<HostStorage> {
  let inventory: Inventory;
  try { inventory = await runHostOperation(storageInventory, { profile: profileRoot(), archivesOnly, archivesLimit }); }
  catch (error: any) { throw new Error(`Could not inspect storage on Local: ${error?.message ?? error}`); }
  return { hostId: 'local', hostName: 'Local', ...inventory, warnings: [...inventory.warnings, ...chatWorktrees.pendingWarnings()] };
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

export async function locateSessionFile(path: string, archived: boolean): Promise<string> {
  const locate = () => (archived ? localArchivedSessionFileAt : localDesktopSessionFileAt)(homeDir(), path);
  return locate();
}

async function retireArchivedSession(client: PiRuntime, sessionPath: string): Promise<void> {
  const local = client.host;
  if (!local?.alive) return;
  const path = await locateSessionFile(sessionPath, false);
  const key = await sessionIdentity(path);
  if (local.alive) await local.host.retire(key, path, true);
}

async function releaseAll(guards: MutationGuard[]): Promise<void> { for (const guard of guards) await guard.release(); }

function maybeCommitted(error: unknown): boolean { return error instanceof StorageTransactionError && error.state !== 'rolled-back'; }

function reportWarnings(app: App, warnings: string[]): void {
  if (!warnings.length) return;
  const line = warnings.join('\n');
  console.error(line);
  app.emit('pi://daemon-error', { hostId: 'local', line });
}

async function undoAfter(error: unknown, undo: () => Promise<void>): Promise<never> {
  if (maybeCommitted(error)) throw error;
  try { await undo(); }
  catch (cleanup: any) { throw new Error(`${(error as any)?.message ?? error}\nWorktree cleanup failed: ${cleanup?.message ?? cleanup}`); }
  throw error;
}

async function archiveSessionPaths(app: App, client: PiRuntime, sessionPath: string, clientId: string, mutations: MutationGuard[]): Promise<string[]> {
  mutations.push(await MutationGuard.acquire(app, sessionPath, clientId, false, 'archive'));
  await retireArchivedSession(client, sessionPath);
  const paths = [sessionPath];
  for (;;) {
    const descendants = (await sessionDescendants(sessionPath, false, false)).map(([path]) => path).filter(path => !paths.includes(path));
    if (!descendants.length) break;
    for (const path of descendants) {
      mutations.push(await MutationGuard.acquire(app, path, clientId, false, 'archive'));
      await retireArchivedSession(client, path);
      paths.push(path);
    }
  }
  return paths;
}

export async function archiveSession(app: App, runtime: TerminalRuntime, sessionPath: string, terminalIds: string[], clientId: string): Promise<void> {
  const client = app.pi;
  await client.lifecycle.run(async () => {
    const mutations: MutationGuard[] = [];
    try {
      const paths = await archiveSessionPaths(app, client, sessionPath, clientId, mutations);
      const sessionIds: string[] = [];
      for (const path of paths) sessionIds.push(await sessionIdentity(path));
      terminalIds.push(...terminalSessions.sessionTerminals(runtime, sessionIds));
      await stopTerminals(runtime, terminalIds);
      await chatWorktrees.cleanUp(sessionIds);
      const archiving = await chatWorktrees.beginArchive(sessionIds);
      const invalidate = app.sessionIndex.projects.invalidateAfter('local');
      try { await storageTransactions.archive(paths); }
      catch (error) { chatWorktrees.stopped(archiving); await undoAfter(error, () => chatWorktrees.rollbackArchive(archiving)); }
      finally { invalidate(); }
      const warnings = await chatWorktrees.finishArchive(archiving);
      for (let index = 0; index < paths.length; index++) {
        try { await mutations[index]!.finishCommitted(); }
        catch (error: any) { warnings.push(`Archive committed, but ownership cleanup failed for ${paths[index]}: ${error?.message ?? error}`); }
        app.emit('pi://session-removed', { hostId: 'local', sessionPath: paths[index], sessionId: sessionIds[index] });
      }
      reportWarnings(app, warnings);
    } finally { await releaseAll(mutations); }
  });
}

type DescendantsRequest = { path: string; root: string; archived: boolean; includeOtherArea: boolean; kinds?: string[] };

// Paths, or path and archived pairs when the request includes the other area.
const descendantsSchema = z.array(z.union([z.string(), z.tuple([z.string(), z.boolean()])]));

const descendantsOperation = hostOperation<DescendantsRequest, z.output<typeof descendantsSchema>>('session-descendants', 'general', STORAGE_TIMEOUT, descendantsSchema);

export const RESTORED_KINDS = ['subagent'];

export async function sessionDescendants(sessionPath: string, archived: boolean, includeOtherArea: boolean, kinds?: string[]): Promise<Array<[string, boolean]>> {
  const root = join(profileRoot(), archived ? 'archived' : 'sessions');
  let value: z.output<typeof descendantsSchema>;
  try { value = await runHostOperation(descendantsOperation, { path: sessionPath, root, archived, includeOtherArea, kinds }); }
  catch (error: any) { throw new Error(`Could not find subagent conversations: ${error?.message ?? error}`); }
  return value.map(item => typeof item === 'string' ? [item, archived] : [item[0], item[1]]);
}

async function deletionTargets(paths: Array<[string, boolean]>): Promise<storageTransactions.DeletionTarget[]> {
  const targets: storageTransactions.DeletionTarget[] = [];
  for (const [path, archived] of paths) {
    const file = await locateSessionFile(path, archived);
    targets.push({ path: file, area: archived ? 'archived' : 'sessions' });
  }
  return targets;
}

async function deleteStoredSessions(app: App, runtime: PiRuntime, sessionPaths: string[], archived: boolean, clientId: string): Promise<string[]> {
  return runtime.lifecycle.run(async () => {
    if (!sessionPaths.length) throw new Error('Select at least one conversation to delete');
    const mutations: MutationGuard[] = [];
    try {
      const paths: Array<[string, boolean]> = [];
      for (const sessionPath of sessionPaths) {
        const path = await locateSessionFile(sessionPath, archived);
        if (paths.some(([existing]) => existing === path)) continue;
        mutations.push(await MutationGuard.acquire(app, path, clientId, archived, 'delete'));
        paths.push([path, archived]);
      }
      const roots = [...paths];
      for (;;) {
        const children: Array<[string, boolean]> = [];
        for (const [path, isArchived] of roots) children.push(...await sessionDescendants(path, isArchived, true));
        let added = false;
        for (const [child, childArchived] of children) {
          if (paths.some(([path]) => path === child)) continue;
          mutations.push(await MutationGuard.acquire(app, child, clientId, childArchived, 'delete'));
          paths.push([child, childArchived]);
          added = true;
        }
        if (!added) break;
      }
      const targets = await deletionTargets(paths);
      const sessionIds: string[] = [];
      for (const [path] of paths) sessionIds.push(await sessionIdentity(path));
      await stopTerminals(app.terminals, terminalSessions.sessionTerminals(app.terminals, sessionIds));
      await chatWorktrees.cleanUp(sessionIds);
      await storageTransactions.deleteSessions(targets, []);
      reportWarnings(app, await chatWorktrees.releaseDeleted(sessionIds));
      for (let index = 0; index < paths.length; index++) {
        try { await mutations[index]!.finishCommitted(); }
        catch (error: any) { console.error(`Conversation deletion committed, but ownership cleanup failed for ${paths[index]![0]}: ${error.message ?? error}`); }
        app.emit('pi://session-removed', { hostId: 'local', sessionPath: paths[index]![0], sessionId: sessionIds[index] });
      }
      try { await sessionGroups.refreshDeletions(app); }
      catch (error: any) { console.error(`Committed deletion group cleanup will retry: ${error.message ?? error}`); }
      return paths.map(([path]) => path);
    } finally { await releaseAll(mutations); }
  });
}

export function deleteSession(app: App, runtime: PiRuntime, sessionPath: string, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [sessionPath], false, clientId);
}

export function deleteArchivedSession(app: App, runtime: PiRuntime, sessionPath: string, sessionPaths: string[] | undefined | null, clientId: string): Promise<string[]> {
  return deleteStoredSessions(app, runtime, [...(sessionPaths ?? []), sessionPath], true, clientId);
}

const restores = new Map<string, Promise<void>>();

export function restoreArchivedSession(app: App, sessionPath: string, clientId: string): Promise<void> {
  const running = restores.get(sessionPath);
  if (running) return running;
  const restore = app.pi.lifecycle.run(() => restoreTree(app, sessionPath, clientId)).finally(() => restores.delete(sessionPath));
  restores.set(sessionPath, restore);
  return restore;
}

async function restoreTree(app: App, sessionPath: string, clientId: string): Promise<void> {
  const restoring = await beginTreeRestore(sessionPath);
  let result: Awaited<ReturnType<typeof restoreSessionTree>>;
  try { result = await restoreSessionTree(sessionPath, path => MutationGuard.acquire(app, path, clientId, true, 'restore'), chatWorktrees.folderMoves(restoring)); }
  catch (error) { chatWorktrees.stopped(restoring); return undoAfter(error, () => chatWorktrees.rollbackRestore(restoring)); }
  try { await chatWorktrees.finishRestore(restoring); }
  catch (error: any) { reportWarnings(app, [`Restore committed; releasing the archive reference will retry: ${error?.message ?? error}`]); }
  for (const session of result.sessions) app.emit('pi://session-restored', { hostId: 'local', sessionId: session.sessionId, sessionPath: session.sessionPath });
  app.emit('pi://sessions-changed', {});
}

async function beginTreeRestore(sessionPath: string): Promise<Awaited<ReturnType<typeof chatWorktrees.beginRestore>>> {
  let source: string;
  try { source = localArchivedSessionFileAt(homeDir(), sessionPath); }
  catch { return []; }
  assertRootRestore(source);
  const tree = [source, ...(await sessionDescendants(source, true, false, RESTORED_KINDS)).map(([path]) => path)];
  const chatIds: string[] = [];
  for (const path of tree) chatIds.push(await sessionIdentity(path));
  return chatWorktrees.beginRestore(chatIds);
}

export async function recoverChatWorktrees(app: App): Promise<void> {
  try { await app.pi.lifecycle.run(() => chatWorktrees.recover()); }
  catch (error: any) { reportWarnings(app, [error?.message ?? String(error)]); }
}

export async function relocateSession(app: App, sessionPath: string, cwd: string, clientId: string): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const mutation = await MutationGuard.acquire(app, sessionPath, clientId, false, 'relocate');
    try {
      try { await runHostOperation(relocateOperation, { profile: profileRoot(), sessionPath, cwd }); }
      catch (error: any) { throw new Error(`Could not relocate conversation: ${error?.message ?? error}`); }
      await mutation.finish();
    } finally { await mutation.release(); }
  });
}

const relocateOperation = hostOperation<{ profile: string; sessionPath: string; cwd: string }, null>('relocate-session', 'general', DEFAULT_TIMEOUT, z.unknown().transform(() => null));

const recoverySchema = z.object({ cwd: z.string(), recovery: z.unknown(), warnings: z.array(z.string()) });

type Recovery = z.output<typeof recoverySchema>;

const recoverOperation = hostOperation<{ action: 'empty'; profile: string; sessionPath: string }, Recovery>('recover-missing-session', 'general', DEFAULT_TIMEOUT, recoverySchema);

export async function recoverMissingSession(app: App, sessionPath: string, action: string, clientId: string): Promise<any> {
  if (action !== 'empty') throw new Error('Unknown recovery action');
  return app.pi.lifecycle.run(async () => {
    const path = await locateSessionFile(sessionPath, false);
    const mutation = await MutationGuard.acquire(app, path, clientId, false, 'relocate');
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
