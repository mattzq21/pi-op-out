import { basename } from 'node:path';
import * as Records from '../resources/chat-worktree-records.cjs';
import { claimWorktree, createWorktree, removeCreatedWorktree, type CreatedWorktree, type Repository } from './chat_worktrees';
import { forgetProjectRepository } from './project_repositories';
import { discardBranchHistory } from './chat_branch_operations';
import { homeDir } from './environment';
import { profileRoot } from './host_operations';
import * as Registry from './session_registry';

export interface ChatWorktreeRecord {
  version: 1;
  chatId: string;
  repository: string;
  gitCommonDir: string;
  worktree: string;
  branch: string;
  state: 'preparing' | 'active' | 'archiving' | 'archived' | 'restoring';
  archive: null | { ref: string; commit: string };
  restore?: { restoreId: string; worktree: string; branch: string; reuse: boolean; retained?: boolean };
  owner?: string;
  protecting?: true;
  repositoryMissing?: true;
  lastError?: string;
}

export interface NewChatWorktree { chatId: string; repository: string; gitCommonDir: string; worktree: string; branch: string }

export const archiveRef: (chatId: string) => string = Records.archiveRef;

export function read(chatId: string, root = profileRoot()): ChatWorktreeRecord | null { return Records.read(root, chatId); }

export function list(root = profileRoot()): ChatWorktreeRecord[] { return Records.list(root); }

export function takenNames(root = profileRoot()): Set<string> {
  const names = new Set<string>();
  for (const record of list(root)) {
    for (const folder of [record.worktree, record.restore?.worktree]) if (folder) names.add(basename(folder));
    for (const branch of [record.branch, record.restore?.branch]) if (branch) names.add(branch.slice('piop/'.length));
  }
  return names;
}

export function replace(before: ChatWorktreeRecord | null, after: ChatWorktreeRecord | null, root = profileRoot()): ChatWorktreeRecord | null {
  return Records.replace(root, (before ?? after)!.chatId, before, after);
}

export function fail(record: ChatWorktreeRecord, message: string, root = profileRoot()): string { return Records.fail(root, record, message); }

export function prepare(fields: NewChatWorktree, root = profileRoot()): ChatWorktreeRecord { return Records.prepare(root, fields); }

export function activate(chatId: string, root = profileRoot()): ChatWorktreeRecord { return Records.activate(root, chatId); }

export async function create(input: { sourceCwd: string; chatId: string; home: string; repository: Repository; baseBranch?: string }, root = profileRoot()): Promise<CreatedWorktree> {
  let record: ChatWorktreeRecord | null = null;
  const claimed = await claimWorktree({ chatId: input.chatId, home: input.home, gitCommonDir: input.repository.gitCommonDir, taken: () => takenNames(root), save: (worktree, branch) => {
    record = record === null ? prepare({ chatId: input.chatId, ...input.repository, worktree, branch }, root) : replace(record, { ...record, worktree, branch }, root);
  } });
  return createWorktree({ ...input, ...claimed });
}

export const RECOVERY_OWNER = 'recovery';

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

export async function recoverPreparing(root = profileRoot()): Promise<string[]> {
  const failures: string[] = [];
  for (const record of list(root)) {
    if (record.state !== 'preparing' || Records.ownerAlive(record.owner)) continue;
    try { await abandonCreation(record.chatId, null, root); }
    catch (error: any) { failures.push(`${record.chatId}: ${error?.message ?? error}`); }
  }
  return failures;
}
