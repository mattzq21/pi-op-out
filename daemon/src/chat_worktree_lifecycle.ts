import { existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { readHeaderLine } from './host/protocol';
import * as SessionTables from '../resources/session-database.cjs';
import { archivedCommit, archiveRef, deleteChatWorktree, planRestore, protectArchive, releaseArchive, removeArchivedWorktree, removeRestoredWorktree, restoreWorktree, type ChatArchive, type ChatWorktree } from './chat_worktrees';
import * as Worktrees from './chat_worktree_records';
import * as Records from '../resources/chat-worktree-records.cjs';
import type { ChatWorktreeRecord } from './chat_worktree_records';
import { homeDir } from './environment';
import { profileRoot } from './host_operations';
import { forgetProjectRepository, rememberProjectRepository } from './project_repositories';
import * as storageTransactions from './storage_transactions';
import type { FolderMove } from './storage_transactions';

function errorText(error: any): string { return error?.message ?? String(error); }

function worktreeOf(record: ChatWorktreeRecord): ChatWorktree {
  return { chatId: record.chatId, repository: record.repository, gitCommonDir: record.gitCommonDir, worktree: record.worktree, branch: record.branch };
}

function archiveOf(record: ChatWorktreeRecord): ChatArchive {
  if (!record.archive) throw new Error('Chat has no saved commit: ' + record.chatId);
  return { ...worktreeOf(record), ...record.archive };
}

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function settled(record: ChatWorktreeRecord): ChatWorktreeRecord { return without(record, 'lastError') as ChatWorktreeRecord; }

async function each<T>(items: T[], step: (item: T) => Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (const item of items) { try { await step(item); } catch (error) { failures.push(errorText(error)); } }
  if (failures.length) throw new Error(failures.join('\n'));
}

const running = new Set<string>();

export function stopped(records: ChatWorktreeRecord[]): void { for (const record of records) running.delete(record.chatId); }

function records(chatIds: string[], root: string): ChatWorktreeRecord[] {
  return chatIds.map(id => Worktrees.read(id, root)).filter((record): record is ChatWorktreeRecord => record !== null);
}

function canonicalFolder(folder: string): string {
  try { return realpathSync(folder); }
  catch (error: any) { if (error.code === 'ENOENT') return resolve(folder); throw error; }
}

function sharedFolder(record: ChatWorktreeRecord, root: string, folder = record.worktree, excludeArchivedChildren = false): boolean {
  const db = SessionTables.open(root);
  let sessions: Array<{ session_id: string; session_path: string }>;
  const children = new Set<string>();
  try {
    sessions = db.prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL AND session_id != ?').all(record.chatId) as typeof sessions;
    if (excludeArchivedChildren) {
      const descendants = db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT child_id FROM auxiliary_children WHERE parent_id=?
        UNION SELECT c.child_id FROM auxiliary_children c JOIN descendants d ON c.parent_id=d.id
      ) SELECT id FROM descendants`).all(record.chatId) as Array<{ id: string }>;
      for (const child of descendants) children.add(child.id);
    }
  }
  finally { db.close(); }
  const target = canonicalFolder(folder);
  for (const session of sessions) {
    if (children.has(session.session_id) && session.session_path.startsWith(join(root, 'archived') + sep)) continue;
    let header: any;
    try { header = JSON.parse(readHeaderLine(session.session_path)); }
    catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    if (typeof header.cwd !== 'string' || !header.cwd) throw new Error(`Chat ${session.session_id} has no working folder; shared worktree cleanup was stopped`);
    const cwd = canonicalFolder(header.cwd);
    if (cwd === target || cwd.startsWith(target + sep)) return true;
  }
  return false;
}

export async function beginArchive(chatIds: string[], root = profileRoot()): Promise<ChatWorktreeRecord[]> {
  const done: ChatWorktreeRecord[] = [];
  try {
    for (const record of records(chatIds, root)) {
      if (record.state !== 'active') throw new Error(`Cannot archive chat ${record.chatId}: its worktree is ${record.state}`);
      running.add(record.chatId);
      let repositoryMissing = false;
      try { await stat(record.gitCommonDir); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; repositoryMissing = true; }
      if (repositoryMissing) {
        done.push(Worktrees.replace(record, { ...without(settled(record), 'protecting'), state: 'archiving', repositoryMissing: true }, root)!);
        continue;
      }
      const intent = await recordProtection(record, root);
      const archive = await protectArchive({ worktree: worktreeOf(intent), home: homeDir() });
      try { done.push(Worktrees.replace(intent, { ...without(settled(intent), 'protecting'), state: 'archiving', archive: { ref: archive.ref, commit: archive.commit } } as ChatWorktreeRecord, root)!); }
      catch (error) {
        try { await releaseArchive(archive); }
        catch (cleanup) { throw new Error(`${errorText(error)}\nCould not release ${archive.ref}: ${errorText(cleanup)}`); }
        throw error;
      }
    }
    return done;
  } catch (error) {
    for (const id of chatIds) running.delete(id);
    try {
      await rollbackArchive(done, root);
      for (const record of records(chatIds, root)) if (record.state === 'active' && record.protecting) await releaseUnrecordedArchive(record, root);
    }
    catch (cleanup) { throw new Error(`${errorText(error)}\nCould not undo the archive references: ${errorText(cleanup)}`); }
    throw error;
  }
}

async function recordProtection(record: ChatWorktreeRecord, root: string): Promise<ChatWorktreeRecord> {
  const current = record.protecting ? await releaseUnrecordedArchive(record, root) : record;
  const ref = archiveRef(record.chatId);
  const existing = await archivedCommit(record);
  if (existing) throw new Error(`Cannot archive chat ${record.chatId}: ${ref} already points to ${existing}; Piop did not create it, so it was kept`);
  return Worktrees.replace(current, { ...settled(current), protecting: true }, root)!;
}

async function releaseUnrecordedArchive(record: ChatWorktreeRecord, root: string): Promise<ChatWorktreeRecord> {
  const ref = archiveRef(record.chatId);
  const commit = await archivedCommit(record);
  if (commit) {
    try { await releaseArchive({ ...worktreeOf(record), ref, commit }); }
    catch (error) { throw new Error(Worktrees.fail(record, `Could not release the unrecorded ${ref}: ${errorText(error)}`, root)); }
  }
  return Worktrees.replace(Worktrees.read(record.chatId, root), without(settled(record), 'protecting') as ChatWorktreeRecord, root)!;
}

export async function rollbackArchive(archiving: ChatWorktreeRecord[], root = profileRoot()): Promise<void> {
  for (const record of archiving) running.delete(record.chatId);
  await each(archiving, async record => {
    try { if (!record.repositoryMissing) await releaseArchive(archiveOf(record)); }
    catch (error) { throw new Error(Worktrees.fail(record, `Could not release the archive reference of chat ${record.chatId}: ${errorText(error)}`, root)); }
    Worktrees.replace(Worktrees.read(record.chatId, root), { ...without(settled(record), 'repositoryMissing'), state: 'active', archive: null }, root);
  });
}

export async function finishArchive(archiving: ChatWorktreeRecord[], root = profileRoot()): Promise<string[]> {
  for (const record of archiving) running.delete(record.chatId);
  const warnings: string[] = [];
  for (const record of archiving) {
    if (record.repositoryMissing) {
      try {
        forgetProjectRepository(root, record.worktree);
        Worktrees.replace(Worktrees.read(record.chatId, root), null, root);
      } catch (error) {
        warnings.push(Worktrees.fail(record, `Archive committed, but the missing repository record could not be cleared: ${errorText(error)}`, root));
        continue;
      }
      continue;
    }
    let archived: ChatWorktreeRecord;
    try { archived = Worktrees.replace(Worktrees.read(record.chatId, root), { ...settled(record), state: 'archived' }, root)!; }
    catch (error) { warnings.push(`Archive committed, but the worktree record of chat ${record.chatId} was not updated: ${errorText(error)}`); continue; }
    try { if (!sharedFolder(archived, root, archived.worktree, true)) await removeArchivedWorktree({ archive: archiveOf(archived), home: homeDir() }); }
    catch (error) { warnings.push(Worktrees.fail(archived, `Archive committed, but worktree ${archived.worktree} was kept: ${errorText(error)}`, root)); }
  }
  return warnings;
}

export async function beginRestore(chatIds: string[], root = profileRoot()): Promise<ChatWorktreeRecord[]> {
  const done: ChatWorktreeRecord[] = [];
  try {
    for (const record of records(chatIds, root)) {
      if (record.state === 'active') continue;
      if (record.state !== 'archived') throw new Error(`Cannot restore chat ${record.chatId}: its worktree is ${record.state}`);
      running.add(record.chatId);
      const archive = archiveOf(record);
      const plan = await planRestore({ archive, home: homeDir(), retainShared: sharedFolder(record, root, record.worktree, true), taken: () => Worktrees.takenNames(root), save: plan => {
        done.push(Worktrees.replace(record, { ...settled(record), state: 'restoring', restore: plan }, root)!);
      } });
      await restoreWorktree({ archive, home: homeDir(), plan });
    }
    return done;
  } catch (error) {
    for (const id of chatIds) running.delete(id);
    try { await rollbackRestore(done, root); }
    catch (cleanup) { throw new Error(`${errorText(error)}\nCould not remove the restored worktrees: ${errorText(cleanup)}`); }
    throw error;
  }
}

export async function rollbackRestore(restoring: ChatWorktreeRecord[], root = profileRoot()): Promise<void> {
  for (const record of restoring) running.delete(record.chatId);
  await each([...restoring].reverse(), async record => {
    try { await removeRestoredWorktree({ archive: archiveOf(record), home: homeDir(), plan: record.restore! }); }
    catch (error) { throw new Error(Worktrees.fail(record, `Could not remove the restored worktree of chat ${record.chatId}: ${errorText(error)}`, root)); }
    Worktrees.replace(Worktrees.read(record.chatId, root), { ...without(settled(record), 'restore'), state: 'archived' } as ChatWorktreeRecord, root);
  });
}

export function folderMoves(restoring: ChatWorktreeRecord[]): FolderMove[] {
  return restoring.filter(record => record.restore!.worktree !== record.worktree).map(record => ({ from: record.worktree, to: record.restore!.worktree }));
}

export async function finishRestore(restoring: ChatWorktreeRecord[], root = profileRoot()): Promise<void> {
  for (const record of restoring) running.delete(record.chatId);
  await each(restoring, async record => {
    const plan = record.restore!;
    try { await releaseArchive(archiveOf(record)); }
    catch (error) { throw new Error(Worktrees.fail(record, `Restore committed, but the archive reference of chat ${record.chatId} was kept: ${errorText(error)}`, root)); }
    const active = { ...without(settled(record), 'restore'), state: 'active', archive: null, worktree: plan.worktree, branch: plan.branch } as ChatWorktreeRecord;
    rememberProjectRepository(root, plan.worktree, { root: plan.worktree, gitDir: record.gitCommonDir });
    Worktrees.replace(Worktrees.read(record.chatId, root), active, root);
    if (plan.worktree !== record.worktree) forgetProjectRepository(root, record.worktree);
  });
}

export async function releaseDeleted(chatIds: string[], root = profileRoot()): Promise<string[]> {
  const warnings: string[] = [];
  for (const record of Worktrees.list(root).filter(record => record.state !== 'preparing' && (chatIds.includes(record.chatId) || transcriptArea(root, record.chatId) === 'missing'))) {
    try {
      if (sharedFolder(record, root) || (record.restore && sharedFolder(record, root, record.restore.worktree))) continue;
      if (record.state === 'restoring') await removeRestoredWorktree({ archive: archiveOf(record), home: homeDir(), plan: record.restore! });
      await deleteChatWorktree({ record: { ...worktreeOf(record), archive: record.archive }, home: homeDir() });
      Worktrees.replace(record, null, root);
      for (const folder of new Set([record.worktree, record.restore?.worktree].filter((path): path is string => Boolean(path)))) forgetProjectRepository(root, folder);
    } catch (error) { warnings.push(Worktrees.fail(record, `Deletion committed, but the Git data of chat ${record.chatId} was kept: ${errorText(error)}`, root)); }
  }
  for (const record of Worktrees.list(root)) {
    if (record.state !== 'archived' || transcriptArea(root, record.chatId) !== 'archived') continue;
    warnings.push(...await finishArchive([record], root));
  }
  return warnings;
}

type Area = 'sessions' | 'archived' | 'missing';

export function pendingWarnings(root = profileRoot()): string[] {
  return Worktrees.list(root).flatMap(record => {
    const unfinished = (!running.has(record.chatId) && (record.state === 'archiving' || record.state === 'restoring' || record.protecting === true)) || (record.state === 'preparing' && !Records.ownerAlive(record.owner));
    if (!record.lastError && !unfinished) return [];
    const step = unfinished ? ` is ${record.state}` : '';
    return [`Worktree ${record.worktree} of chat ${record.chatId}${step}${record.lastError ? ': ' + record.lastError : ''}. Piop retries when it starts again.`];
  });
}

function transcriptArea(root: string, chatId: string): Area {
  const path = SessionTables.lookup(root, chatId);
  if (typeof path !== 'string' || !existsSync(path)) return 'missing';
  for (const area of ['sessions', 'archived'] as const) if (path.startsWith(join(root, area) + sep)) return area;
  throw new Error(`Transcript of chat ${chatId} is outside Piop storage: ${path}`);
}

export async function recover(root = profileRoot()): Promise<void> {
  await storageTransactions.recover({ root });
  const failures = await Worktrees.recoverPreparing(root);
  for (const record of Worktrees.list(root)) {
    if (record.state === 'preparing') continue;
    try {
      const area = transcriptArea(root, record.chatId);
      if (area === 'missing') { failures.push(...await releaseDeleted([record.chatId], root)); continue; }
      if (record.state === 'archiving') {
        if (area === 'archived') failures.push(...await finishArchive([record], root));
        else await rollbackArchive([record], root);
      } else if (record.state === 'restoring') {
        if (area === 'sessions') await finishRestore([record], root);
        else await rollbackRestore([record], root);
      } else if (record.state === 'archived') {
        if (area !== 'archived') throw new Error('Chat worktree is archived, but its transcript is active');
        failures.push(...await finishArchive([record], root));
      } else if (area !== 'sessions') throw new Error('Chat worktree is active, but its transcript is archived');
      else if (record.protecting) await releaseUnrecordedArchive(record, root);
    } catch (error) { failures.push(`${record.chatId}: ${errorText(error)}`); }
  }
  if (failures.length) throw new Error('Chat worktree recovery is pending:\n' + failures.join('\n'));
}
