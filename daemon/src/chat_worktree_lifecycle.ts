import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as SessionTables from '../resources/session-database.cjs';
import { deleteChatWorktree, planRestore, protectArchive, releaseArchive, removeArchivedWorktree, removeRestoredWorktree, restoreWorktree, type ChatArchive, type ChatWorktree } from './chat_worktrees';
import * as Worktrees from './chat_worktree_records';
import type { ChatWorktreeRecord } from './chat_worktree_records';
import { homeDir } from './environment';
import { profileRoot } from './host_operations';
import { rememberProjectRepository } from './project_repositories';
import * as storageTransactions from './storage_transactions';

/*
 * Archive, restore and permanent deletion of the worktrees Piop created for chats (ADR 0006). Each step that changes Git
 * is recorded in the chat worktree record first or right after, so recovery() can finish or undo it after a crash. The
 * transcript storage transaction is the commit point: a record in a middle state follows where the transcript is.
 */

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

/** Runs every cleanup and throws one error that lists each failure. */
async function each<T>(items: T[], step: (item: T) => Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (const item of items) { try { await step(item); } catch (error) { failures.push(errorText(error)); } }
  if (failures.length) throw new Error(failures.join('\n'));
}

function records(chatIds: string[], root: string): ChatWorktreeRecord[] {
  return chatIds.map(id => Worktrees.read(id, root)).filter((record): record is ChatWorktreeRecord => record !== null);
}

/**
 * Protects the last commit of each Piop worktree of chatIds with its archive reference and records the chat as archiving.
 * Chats without a Piop worktree are skipped. On failure, undoes what it did and throws; the worktrees stay.
 */
export async function beginArchive(chatIds: string[], root = profileRoot()): Promise<ChatWorktreeRecord[]> {
  const done: ChatWorktreeRecord[] = [];
  try {
    for (const record of records(chatIds, root)) {
      if (record.state !== 'active') throw new Error(`Cannot archive chat ${record.chatId}: its worktree is ${record.state}`);
      const archive = await protectArchive({ worktree: worktreeOf(record), home: homeDir() });
      try { done.push(Worktrees.replace(record, { ...settled(record), state: 'archiving', archive: { ref: archive.ref, commit: archive.commit } }, root)!); }
      catch (error) {
        try { await releaseArchive(archive); }
        catch (cleanup) { throw new Error(`${errorText(error)}\nCould not release ${archive.ref}: ${errorText(cleanup)}`); }
        throw error;
      }
    }
    return done;
  } catch (error) {
    try { await rollbackArchive(done, root); }
    catch (cleanup) { throw new Error(`${errorText(error)}\nCould not undo the archive references: ${errorText(cleanup)}`); }
    throw error;
  }
}

/** Undoes beginArchive after the transcripts stayed active: releases each archive reference and marks the chat active again. */
export async function rollbackArchive(archiving: ChatWorktreeRecord[], root = profileRoot()): Promise<void> {
  await each(archiving, async record => {
    try { await releaseArchive(archiveOf(record)); }
    catch (error) { throw new Error(Worktrees.fail(record, `Could not release the archive reference of chat ${record.chatId}: ${errorText(error)}`, root)); }
    Worktrees.replace(Worktrees.read(record.chatId, root), { ...settled(record), state: 'active', archive: null }, root);
  });
}

/**
 * Finishes the archive after the transcripts were archived: marks each chat archived, then removes its worktree folder.
 * Changes after the saved commit and ignored files are discarded. Returns warnings for folders that remain.
 */
export async function finishArchive(archiving: ChatWorktreeRecord[], root = profileRoot()): Promise<string[]> {
  const warnings: string[] = [];
  for (const record of archiving) {
    let archived: ChatWorktreeRecord;
    try { archived = Worktrees.replace(Worktrees.read(record.chatId, root), { ...settled(record), state: 'archived' }, root)!; }
    catch (error) { warnings.push(`Archive committed, but the worktree record of chat ${record.chatId} was not updated: ${errorText(error)}`); continue; }
    try { await removeArchivedWorktree({ archive: archiveOf(archived), home: homeDir() }); }
    catch (error) { warnings.push(Worktrees.fail(archived, `Archive committed, but worktree ${archived.worktree} was kept: ${errorText(error)}`, root)); }
  }
  return warnings;
}

/**
 * Recreates the worktree of each archived chat of chatIds from its saved commit, and records the plan first so a crash
 * can undo it. Keeps the archive references. On failure, removes what it created and throws; the chats stay archived.
 */
export async function beginRestore(chatIds: string[], root = profileRoot()): Promise<ChatWorktreeRecord[]> {
  const done: ChatWorktreeRecord[] = [];
  try {
    for (const record of records(chatIds, root)) {
      if (record.state === 'active') continue;
      if (record.state !== 'archived') throw new Error(`Cannot restore chat ${record.chatId}: its worktree is ${record.state}`);
      const archive = archiveOf(record);
      const plan = await planRestore({ archive, home: homeDir() });
      const restoring = Worktrees.replace(record, { ...settled(record), state: 'restoring', restore: plan }, root)!;
      done.push(restoring);
      await restoreWorktree({ archive, home: homeDir(), plan });
    }
    return done;
  } catch (error) {
    try { await rollbackRestore(done, root); }
    catch (cleanup) { throw new Error(`${errorText(error)}\nCould not remove the restored worktrees: ${errorText(cleanup)}`); }
    throw error;
  }
}

/** Undoes beginRestore after the transcripts stayed archived: removes the restored folders and new branches. */
export async function rollbackRestore(restoring: ChatWorktreeRecord[], root = profileRoot()): Promise<void> {
  await each([...restoring].reverse(), async record => {
    try { await removeRestoredWorktree({ archive: archiveOf(record), home: homeDir(), plan: record.restore! }); }
    catch (error) { throw new Error(Worktrees.fail(record, `Could not remove the restored worktree of chat ${record.chatId}: ${errorText(error)}`, root)); }
    Worktrees.replace(Worktrees.read(record.chatId, root), { ...without(settled(record), 'restore'), state: 'archived' } as ChatWorktreeRecord, root);
  });
}

export interface Relocation { chatId: string; from: string; to: string }

/** The chats whose restored folder differs from the archived one. Their transcripts must point at the new folder before finishRestore. */
export function relocations(restoring: ChatWorktreeRecord[]): Relocation[] {
  return restoring.filter(record => record.restore!.worktree !== record.worktree).map(record => ({ chatId: record.chatId, from: record.worktree, to: record.restore!.worktree }));
}

/**
 * Finishes the restore after the transcripts were restored: releases each archive reference and marks the chat active
 * with its restored folder and branch. Throws when a reference cannot be released; the record stays restoring so
 * recovery retries.
 */
export async function finishRestore(restoring: ChatWorktreeRecord[], root = profileRoot()): Promise<void> {
  await each(restoring, async record => {
    const plan = record.restore!;
    try { await releaseArchive(archiveOf(record)); }
    catch (error) { throw new Error(Worktrees.fail(record, `Restore committed, but the archive reference of chat ${record.chatId} was kept: ${errorText(error)}`, root)); }
    const active = { ...without(settled(record), 'restore'), state: 'active', archive: null, worktree: plan.worktree, branch: plan.branch } as ChatWorktreeRecord;
    rememberProjectRepository(root, plan.worktree, { root: plan.worktree, gitDir: record.gitCommonDir });
    Worktrees.replace(Worktrees.read(record.chatId, root), active, root);
  });
}

/**
 * Releases what permanently deleted chats held in Git: worktree folder, archive reference and branch, then the record.
 * Call after the deletion committed. Returns warnings for parts that remain; recovery retries them.
 */
export async function releaseDeleted(chatIds: string[], root = profileRoot()): Promise<string[]> {
  const warnings: string[] = [];
  for (const record of records(chatIds, root)) {
    try {
      if (record.state === 'restoring') await removeRestoredWorktree({ archive: archiveOf(record), home: homeDir(), plan: record.restore! });
      await deleteChatWorktree({ record: { ...worktreeOf(record), archive: record.archive }, home: homeDir() });
      Worktrees.replace(record, null, root);
    } catch (error) { warnings.push(Worktrees.fail(record, `Deletion committed, but the Git data of chat ${record.chatId} was kept: ${errorText(error)}`, root)); }
  }
  return warnings;
}

type Area = 'sessions' | 'archived' | 'missing';

function transcriptArea(root: string, chatId: string): Area {
  const path = SessionTables.lookup(root, chatId);
  if (typeof path !== 'string' || !existsSync(path)) return 'missing';
  for (const area of ['sessions', 'archived'] as const) if (path.startsWith(join(root, area) + sep)) return area;
  throw new Error(`Transcript of chat ${chatId} is outside Piop storage: ${path}`);
}

/**
 * Brings every chat worktree record to a final state after a crash: undoes creations whose process ended, and finishes or
 * undoes archive, restore and deletion steps according to where the transcript is. Run while no chat lifecycle
 * operation runs. relocate points a restored transcript and its subagent transcripts at the moved folder; it must be
 * idempotent. Throws with every failure that remains.
 */
export async function recover(relocate: (moved: Relocation) => Promise<void>, root = profileRoot()): Promise<void> {
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
        if (area === 'sessions') {
          for (const moved of relocations([record])) await relocate(moved);
          await finishRestore([record], root);
        } else await rollbackRestore([record], root);
      } else if (record.state === 'archived') {
        if (area !== 'archived') throw new Error('Chat worktree is archived, but its transcript is active');
        if (existsSync(record.worktree)) failures.push(...await finishArchive([record], root));
      } else if (area !== 'sessions') throw new Error('Chat worktree is active, but its transcript is archived');
    } catch (error) { failures.push(`${record.chatId}: ${errorText(error)}`); }
  }
  if (failures.length) throw new Error('Chat worktree recovery is pending:\n' + failures.join('\n'));
}
