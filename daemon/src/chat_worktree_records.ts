import * as Records from '../resources/chat-worktree-records.cjs';
import { claimWorktree, createWorktree, removeCreatedWorktree, type CreatedWorktree, type Repository } from './chat_worktrees';
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
  restore?: { restoreId: string; worktree: string; branch: string; reuse: boolean; retained?: boolean };
  /** Process that creates the worktree; only while preparing. */
  owner?: string;
  /** Set on an active record while its archive reference may exist without the archiving state. */
  protecting?: true;
  repositoryMissing?: true;
  /** Error of the last failed cleanup; recovery retries. */
  lastError?: string;
}

export interface NewChatWorktree { chatId: string; repository: string; gitCommonDir: string; worktree: string; branch: string }

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
 * Creates the worktree of a new chat: claims the shortest free folder and branch name, recording each name before its
 * folder exists, then checks it out. Recovery undoes a creation that stops part way.
 */
export async function create(input: { sourceCwd: string; chatId: string; home: string; repository: Repository; baseBranch?: string }, root = profileRoot()): Promise<CreatedWorktree> {
  let record: ChatWorktreeRecord | null = null;
  const claimed = await claimWorktree({ chatId: input.chatId, home: input.home, gitCommonDir: input.repository.gitCommonDir, save: (worktree, branch) => {
    record = record === null ? prepare({ chatId: input.chatId, ...input.repository, worktree, branch }, root) : replace(record, { ...record, worktree, branch }, root);
  } });
  return createWorktree({ ...input, ...claimed });
}

/** Owner of a creation whose cleanup failed. No process has this token, so the next recovery run takes it over. */
export const RECOVERY_OWNER = 'recovery';

/**
 * Undoes a creation that was not handed to the user, in order: discards the new transcript, its publication journals and
 * attachment claims, removes the worktree and branch, releases the reserved chat ID, then forgets the record. The record
 * goes last so it marks unfinished cleanup until every other step succeeded. First puts an active record
 * back to preparing, owned by this process, so a crash during cleanup leaves it for recovery. Each step needs the one
 * before it; the first failure stops the cleanup, keeps the record owned by recovery with lastError, and throws.
 */
export async function abandonCreation(chatId: string, sessionPath: string | null, root = profileRoot()): Promise<void> {
  let record = read(chatId, root);
  if (record !== null) {
    if (record.state !== 'preparing' && record.state !== 'active') throw new Error(`Chat worktree is ${record.state}; only an unfinished creation can be undone: ${chatId}`);
    record = replace(record, { ...record, state: 'preparing', owner: Records.processToken() }, root)!;
  }
  try {
    await discardBranchHistory(root, chatId, sessionPath);
    if (record !== null) {
      await removeCreatedWorktree({ chatId, gitCommonDir: record.gitCommonDir, home: homeDir(), worktree: record.worktree, branch: record.branch });
      forgetProjectRepository(root, record.worktree);
    }
    Registry.releaseReservation(root, chatId);
    if (record !== null) replace(record, null, root);
  } catch (error: any) {
    const message = `Could not undo the creation of chat ${chatId}: ${error?.message ?? error}`;
    const current = read(chatId, root);
    if (current === null) throw new Error(message);
    try { record = replace(current, { ...current, state: 'preparing', owner: RECOVERY_OWNER }, root)!; }
    catch (update: any) { throw new Error(`${message}\nCleanup record could not be handed to recovery: ${update?.message ?? update}`); }
    throw new Error(fail(record, message, root));
  }
}

/**
 * Undoes creations whose process ended or whose cleanup failed. Returns the errors of records that still need recovery.
 */
export async function recoverPreparing(root = profileRoot()): Promise<string[]> {
  const failures: string[] = [];
  for (const record of list(root)) {
    if (record.state !== 'preparing' || Records.ownerAlive(record.owner)) continue;
    try { await abandonCreation(record.chatId, null, root); }
    catch (error: any) { failures.push(`${record.chatId}: ${error?.message ?? error}`); }
  }
  return failures;
}
