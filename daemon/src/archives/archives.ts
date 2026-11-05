import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { z } from 'zod';
import { archivedConversationSchema, hostStorageSchema, storageCategorySchema } from '../../../protocol/results';
import { STORAGE_DIRECTORY } from '../config';
import { homeDir } from '../environment';
import { sessionIdentity } from '../pi';
import { desktopSessionsDir } from '../process';
import { DEFAULT_TIMEOUT, hostOperation, profileRoot, runHostOperation, STORAGE_TIMEOUT } from '../host_operations';
import * as chatWorktrees from '../worktrees';
import { MutationGuard } from './ownership';
import * as sessionGroups from '../sessions';
import * as terminalSessions from '../terminals';
import { stopTerminals } from '../terminals';
import type { PiRuntime } from '../pi';
import type { TerminalRuntime } from '../terminals';
import type { App } from '../app';
import * as SessionLifecycle from '../storage/lifecycle.ts';
import type { SavedSession } from '../storage/lifecycle.ts';
import { isAuxiliary, records } from '../../resources/piop-storage/session-records.ts';
import type { FolderMove } from '../worktrees/lifecycle.ts';
import { readHeaderLine } from '../host/protocol';

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

// The transcript at sessionPath, when it is a saved chat that is archived, or not.
export function locateSessionFile(sessionPath: string, archived: boolean): string {
  let root: string; let source: string;
  try { root = realpathSync(desktopSessionsDir(homeDir())); } catch (error: any) { throw new Error(`Could not locate piop sessions: ${error.message}`); }
  try { source = realpathSync(sessionPath); } catch (error: any) { throw new Error(`Could not locate ${archived ? 'archived conversation' : 'session file'}: ${error.message}`); }
  const saved = within(source, root) && extname(source) === '.jsonl' && isFile(source) ? registered(source) : undefined;
  if (saved?.archived !== archived) throw new Error(archived ? 'Only archived piop conversations can be accessed' : 'Only piop session files can be accessed');
  return source;
}

function registered(path: string): SavedSession | undefined {
  try {
    const id = SessionLifecycle.idOf(path);
    return id === undefined ? undefined : SessionLifecycle.session(id);
  } catch { return undefined; }
}

async function releaseAll(guards: MutationGuard[]): Promise<void> { for (const guard of guards) await guard.release(); }

function reportWarnings(app: App, warnings: string[]): void {
  if (!warnings.length) return;
  const line = warnings.join('\n');
  console.error(line);
  app.emit('pi://daemon-error', { hostId: 'local', line });
}

async function undoAfter(error: unknown, undo: () => Promise<void>): Promise<never> {
  try { await undo(); }
  catch (cleanup: any) { throw new Error(`${(error as any)?.message ?? error}\nWorktree cleanup failed: ${cleanup?.message ?? cleanup}`); }
  throw error;
}

async function finishAll(guards: MutationGuard[], tree: SavedSession[], action: string, warnings: string[]): Promise<void> {
  for (const [index, guard] of guards.entries()) {
    try { await guard.finish(); }
    catch (error: any) { warnings.push(`${action} committed, but ownership cleanup failed for ${tree[index]!.sessionPath}: ${error?.message ?? error}`); }
  }
}

// Holds sessionId and the active chats under it, and stops their runtimes. New chats under them are held too.
async function holdArchiveTree(app: App, sessionId: string, clientId: string, guards: MutationGuard[]): Promise<SavedSession[]> {
  const tree: SavedSession[] = [];
  const hold = async (id: string) => {
    guards.push(await MutationGuard.acquire(app, id, clientId, 'archive'));
    const saved = SessionLifecycle.session(id)!;
    const local = app.pi.host;
    if (local?.alive) await local.host.retire(id, saved.sessionPath, true);
    tree.push(saved);
  };
  await hold(sessionId);
  for (;;) {
    const added = SessionLifecycle.descendants(sessionId, { archived: false }).filter(child => !tree.some(saved => saved.sessionId === child.sessionId));
    if (!added.length) return tree;
    for (const child of added) await hold(child.sessionId);
  }
}

export async function archiveSession(app: App, runtime: TerminalRuntime, sessionId: string, terminalIds: string[], clientId: string): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const guards: MutationGuard[] = [];
    try {
      const tree = await holdArchiveTree(app, sessionId, clientId, guards);
      const ids = tree.map(saved => saved.sessionId);
      await stopTerminals(runtime, [...terminalIds, ...terminalSessions.sessionTerminals(runtime, ids)]);
      const archiving = await chatWorktrees.beginArchive(ids);
      const invalidate = app.sessionIndex.projects.invalidateAfter('local');
      try { SessionLifecycle.archive(ids); }
      catch (error) { chatWorktrees.stopped(archiving); await undoAfter(error, () => chatWorktrees.rollbackArchive(archiving)); }
      finally { invalidate(); }
      const warnings = await chatWorktrees.finishArchive(archiving);
      await finishAll(guards, tree, 'Archive', warnings);
      for (const saved of tree) app.emit('pi://session-removed', { hostId: 'local', sessionPath: saved.sessionPath, sessionId: saved.sessionId });
      reportWarnings(app, warnings);
    } finally { await releaseAll(guards); }
  });
}

// Deletes the chats sessionIds, archived or not, and every chat under them. Gives the IDs of the deleted chats.
export function deleteSessions(app: App, sessionIds: string[], clientId: string): Promise<string[]> {
  return app.pi.lifecycle.run(async () => {
    if (!sessionIds.length) throw new Error('Select at least one conversation to delete');
    const guards: MutationGuard[] = [];
    const tree: SavedSession[] = [];
    const hold = async (id: string) => {
      if (tree.some(saved => saved.sessionId === id)) return false;
      guards.push(await MutationGuard.acquire(app, id, clientId, 'delete'));
      tree.push(SessionLifecycle.session(id)!);
      return true;
    };
    try {
      for (const id of sessionIds) await hold(id);
      for (let added = true; added;) {
        added = false;
        for (const saved of [...tree]) for (const child of SessionLifecycle.descendants(saved.sessionId)) added = await hold(child.sessionId) || added;
      }
      const ids = tree.map(saved => saved.sessionId);
      await stopTerminals(app.terminals, terminalSessions.sessionTerminals(app.terminals, ids));
      await SessionLifecycle.deleteSessions(ids);
      const warnings = await chatWorktrees.releaseDeleted(ids);
      await finishAll(guards, tree, 'Deletion', warnings);
      for (const saved of tree) app.emit('pi://session-removed', { hostId: 'local', sessionPath: saved.sessionPath, sessionId: saved.sessionId });
      reportWarnings(app, warnings);
      try { await sessionGroups.refreshDeletions(app); }
      catch (error: any) { console.error(`Committed deletion group cleanup will retry: ${error.message ?? error}`); }
      return ids;
    } finally { await releaseAll(guards); }
  });
}

export const RESTORED_KINDS = ['subagent'];

const restores = new Map<string, Promise<void>>();

export function restoreSession(app: App, sessionId: string, clientId: string): Promise<void> {
  const running = restores.get(sessionId);
  if (running) return running;
  const restore = app.pi.lifecycle.run(() => restoreTree(app, sessionId, clientId)).finally(() => restores.delete(sessionId));
  restores.set(sessionId, restore);
  return restore;
}

// Restores sessionId with its archived subagents. Their worktrees come back first; when one comes back in another
// folder, the chats that worked in the old folder are moved to it after the commit.
async function restoreTree(app: App, sessionId: string, clientId: string): Promise<void> {
  const root = SessionLifecycle.session(sessionId);
  if (!root) throw new Error('This conversation has been deleted');
  if (!root.archived) throw new Error('This conversation is not archived');
  assertRootRestore(root);
  const tree = [root, ...SessionLifecycle.descendants(sessionId, { archived: true, kinds: RESTORED_KINDS })];
  const ids = tree.map(saved => saved.sessionId);
  const guards: MutationGuard[] = [];
  try {
    for (const id of ids) guards.push(await MutationGuard.acquire(app, id, clientId, 'restore'));
    const restoring = await chatWorktrees.beginRestore(ids);
    try { SessionLifecycle.restore(ids); }
    catch (error) { chatWorktrees.stopped(restoring); await undoAfter(error, () => chatWorktrees.rollbackRestore(restoring)); }
    const warnings = await moveFolders(tree, chatWorktrees.folderMoves(restoring));
    try { await chatWorktrees.finishRestore(restoring); }
    catch (error: any) { warnings.push(`Restore committed; releasing the archive reference will retry: ${error?.message ?? error}`); }
    await finishAll(guards, tree, 'Restore', warnings);
    reportWarnings(app, warnings);
    for (const saved of tree) app.emit('pi://session-restored', { hostId: 'local', sessionId: saved.sessionId, sessionPath: saved.sessionPath });
    app.emit('pi://sessions-changed', {});
  } finally { await releaseAll(guards); }
}

function assertRootRestore(saved: SavedSession): void {
  const entries = readFileSync(saved.sessionPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  if (isAuxiliary([...entries, ...records(saved.sessionPath, saved.sessionId).map((record: any) => record.entry)])) throw new Error('Auxiliary sessions can only be restored with their root session');
}

async function moveFolders(tree: SavedSession[], moves: FolderMove[]): Promise<string[]> {
  const warnings: string[] = [];
  if (!moves.length) return warnings;
  for (const saved of tree) {
    try {
      const cwd = JSON.parse(readHeaderLine(saved.sessionPath))?.cwd;
      const move = moves.find(item => item.from === cwd);
      if (move) await runHostOperation(relocateOperation, { profile: profileRoot(), sessionPath: saved.sessionPath, cwd: move.to, from: move.from });
    } catch (error: any) { warnings.push(`Restore committed, but ${saved.sessionPath} still works in its old folder: ${error?.message ?? error}`); }
  }
  return warnings;
}

// Removes the files of chats that were deleted while the daemon stopped.
export function sweepDeletedSessions(app: App): void {
  try { reportWarnings(app, SessionLifecycle.sweep()); }
  catch (error: any) { reportWarnings(app, [`Could not remove the files of deleted conversations: ${error?.message ?? error}`]); }
}

export async function recoverChatWorktrees(app: App): Promise<void> {
  try { await app.pi.lifecycle.run(() => chatWorktrees.recover()); }
  catch (error: any) { reportWarnings(app, [error?.message ?? String(error)]); }
}

export async function relocateSession(app: App, sessionPath: string, cwd: string, clientId: string): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const mutation = await MutationGuard.acquire(app, await sessionIdentity(locateSessionFile(sessionPath, false)), clientId, 'relocate');
    try {
      try { await runHostOperation(relocateOperation, { profile: profileRoot(), sessionPath, cwd }); }
      catch (error: any) { throw new Error(`Could not relocate conversation: ${error?.message ?? error}`); }
      await mutation.finish();
    } finally { await mutation.release(); }
  });
}

const relocateOperation = hostOperation<{ profile: string; sessionPath: string; cwd: string; from?: string }, null>('relocate-session', 'general', DEFAULT_TIMEOUT, z.unknown().transform(() => null));

const recoverySchema = z.object({ cwd: z.string(), recovery: z.unknown(), warnings: z.array(z.string()) });

type Recovery = z.output<typeof recoverySchema>;

const recoverOperation = hostOperation<{ action: 'empty'; profile: string; sessionPath: string }, Recovery>('recover-missing-session', 'general', DEFAULT_TIMEOUT, recoverySchema);

export async function recoverMissingSession(app: App, sessionPath: string, action: string, clientId: string): Promise<any> {
  if (action !== 'empty') throw new Error('Unknown recovery action');
  return app.pi.lifecycle.run(async () => {
    const path = locateSessionFile(sessionPath, false);
    const mutation = await MutationGuard.acquire(app, await sessionIdentity(path), clientId, 'relocate');
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
