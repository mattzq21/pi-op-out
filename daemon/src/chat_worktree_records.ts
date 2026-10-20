import * as Records from '../resources/chat-worktree-records.cjs';
import * as SessionTables from '../resources/session-database.cjs';
import { removeCreatedWorktree } from './chat_worktrees';
import { forgetProjectRepository } from './project_repositories';
import { discardBranchHistory } from './chat_branch_operations';
import { homeDir } from './environment';
import { profileRoot } from './host_operations';
import * as Registry from './session_registry';

/**
 * What Piop knows about a worktree that it created for one chat, keyed by chat ID in the profile database of this
 * machine. Chats in the original project folder have no record. The state is also the journal of each multi-step change:
 * preparing (creation runs), active, archiving (archive reference saved, transcript not yet archived), archived,
 * restoring (restore plan saved, transcript not yet restored).
 */
export interface ChatWorktreeRecord {
  version: 1;
  chatId: string;
  /** Real path of the main worktree of the source repository. */
  repository: string;
  /** Real path of the shared Git storage of the source repository. */
  gitCommonDir: string;
  worktree: string;
  /** Branch name without refs/heads/. */
  branch: string;
  state: 'preparing' | 'active' | 'archiving' | 'archived' | 'restoring';
  archive: null | { ref: string; commit: string };
  restore?: { restoreId: string; worktree: string; branch: string; reuse: boolean };
  /** Process that creates the worktree; only while preparing. */
  owner?: string;
  /** Error of the last failed cleanup; recovery retries. */
  lastError?: string;
}

export interface NewChatWorktree { chatId: string; repository: string; gitCommonDir: string; worktree: string }

export const archiveRef: (chatId: string) => string = Records.archiveRef;

export function read(chatId: string, root = profileRoot()): ChatWorktreeRecord | null { return Records.read(root, chatId); }

export function list(root = profileRoot()): ChatWorktreeRecord[] { return Records.list(root); }

/** Writes after only while the stored record still equals before. Throws when it changed. */
export function replace(before: ChatWorktreeRecord | null, after: ChatWorktreeRecord | null, root = profileRoot()): ChatWorktreeRecord | null {
  return Records.replace(root, (before ?? after)!.chatId, before, after);
}

/** Saves message as the last error of record and returns the text to report. */
export function fail(record: ChatWorktreeRecord, message: string, root = profileRoot()): string { return Records.fail(root, record, message); }

/** Call before any Git change of a new chat. Throws when the chat already has a record. */
export function prepare(fields: NewChatWorktree, root = profileRoot()): ChatWorktreeRecord { return Records.prepare(root, fields); }

/** Call when the new chat is complete. Until then recovery undoes the creation. */
export function activate(chatId: string, root = profileRoot()): ChatWorktreeRecord { return Records.activate(root, chatId); }

/**
 * Undoes a creation that did not complete: removes the worktree folder and branch, then the record. Accepts a preparing
 * record, or an active one whose chat was never handed to the user. Throws and keeps the record with lastError on failure.
 */
export async function abandon(chatId: string, root = profileRoot()): Promise<void> {
  const record = read(chatId, root);
  if (record === null) return;
  if (record.state !== 'preparing' && record.state !== 'active') throw new Error(`Chat worktree is ${record.state}; only an unfinished creation can be undone: ${chatId}`);
  try { await removeCreatedWorktree({ chatId, gitCommonDir: record.gitCommonDir, home: homeDir() }); }
  catch (error: any) { throw new Error(fail(record, `Could not undo the worktree of chat ${chatId}: ${error?.message ?? error}`, root)); }
  forgetProjectRepository(root, record.worktree);
  replace(read(chatId, root), null, root);
}

/**
 * Undoes creations whose process ended before activation: discards the new transcript and its attachment claims, removes
 * the worktree and branch, then releases the reserved chat ID. Returns the errors of records that still need recovery.
 */
export async function recoverPreparing(root = profileRoot()): Promise<string[]> {
  const failures: string[] = [];
  for (const record of list(root)) {
    if (record.state !== 'preparing' || Records.ownerAlive(record.owner)) continue;
    try {
      const sessionPath = SessionTables.lookup(root, record.chatId);
      if (typeof sessionPath === 'string') await discardBranchHistory(root, record.chatId, sessionPath);
      await abandon(record.chatId, root);
      Registry.releaseReservation(root, record.chatId);
    } catch (error: any) { failures.push(`${record.chatId}: ${error?.message ?? error}`); }
  }
  return failures;
}
