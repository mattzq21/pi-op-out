import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/*
 * All Git work of ADR 0006: finding the repository, automatic progress commits, and creating, archiving, restoring
 * and deleting chat worktrees. Each step is a separate call so chat_worktree_records can journal it first. Every
 * removal is idempotent and removes only what Piop owns: a folder Git lists as a worktree of this repository, inside
 * the Piop worktrees folder, and branches named after the chat. Calls for one repository run one at a time, keyed by
 * its shared Git storage, so chats never race on its refs, index or worktree list.
 */

export const SAVE_MESSAGE = 'Piop saving progress';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHAT_ID = new RegExp(`^${UUID}$`);
/** A worktree folder and branch name: the shortest free start of the chat ID, 4 to 32 hex digits. Older chats used the full ID. */
const NAME = new RegExp(`^([0-9a-f]{4,32}|${UUID}(-${UUID})?)$`);
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `repository` is the main worktree top folder; `gitCommonDir` is the shared Git storage. Both are real paths. */
export type Repository = { repository: string; gitCommonDir: string };
/** A chat worktree. `branch` has no refs/heads/ prefix. */
export type ChatWorktree = Repository & { chatId: string; worktree: string; branch: string };
/** A new chat worktree; `commit` is the source HEAD it starts from. The current files sit on it as uncommitted changes. */
export type CreatedWorktree = ChatWorktree & { commit: string };
/** An archived chat: `ref` (refs/piop/archives/<chatId>) protects `commit` in the shared Git storage. */
export type ChatArchive = ChatWorktree & { ref: string; commit: string };
/** How one restore attempt places the worktree. `restoreId` is fresh per attempt; `reuse` keeps the old branch. */
export type RestorePlan = { restoreId: string; worktree: string; branch: string; reuse: boolean; retained?: boolean };

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly code: number | null, readonly stderr: string) { super(message); }
}

type Run = { stdout: string; stderr: string; code: number };

const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE'];

function git(cwd: string, args: string[], options: { env?: Record<string, string>; allow?: number[] } = {}): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const name of INHERITED) delete env[name];
  Object.assign(env, options.env);
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
      if (code !== null && (code === 0 || options.allow?.includes(code))) return resolve({ stdout, stderr, code });
      reject(new GitError(`git ${args.join(' ')} failed in ${cwd}: ${(stderr || error?.message || '').trim()}`, args, code, stderr));
    });
  });
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier call for the same Git common dir has finished. */
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = next.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function chatId(value: string): string {
  if (!CHAT_ID.test(value)) throw new Error(`Chat ID must be a lowercase UUID: ${value}`);
  return value;
}

export function worktreesRoot(home: string): string {
  return join(home, '.local', 'share', 'piop', 'worktrees');
}

/** Names to try for a chat worktree, shortest first: the first 4, 5, … 32 hex digits of the chat ID. */
function names(id: string): string[] {
  const hex = chatId(id).replaceAll('-', '');
  return Array.from({ length: hex.length - 3 }, (_, index) => hex.slice(0, index + 4));
}

/** The first name whose folder and branch `piop/<name>` are both free, or null. Read only. */
async function freeName(id: string, home: string, gitCommonDir: string, skip = new Set<string>()): Promise<string | null> {
  for (const name of names(id)) {
    if (skip.has(name) || await exists(join(worktreesRoot(home), name)) || await commitOf(gitCommonDir, `refs/heads/piop/${name}`)) continue;
    return name;
  }
  return null;
}

/**
 * Claims a folder and branch name for a new chat worktree: the shortest free start of the chat ID. `save` records the
 * name before the folder exists, so recovery can remove it. The folder is then made with mkdir, which fails when another
 * process made it first; then the next name is tried. Returns the empty folder and the branch to create.
 */
export async function claimWorktree(input: { chatId: string; home: string; gitCommonDir: string; save: (worktree: string, branch: string) => void }): Promise<{ worktree: string; branch: string }> {
  return serialized(input.gitCommonDir, async () => {
    await mkdir(worktreesRoot(input.home), { recursive: true, mode: 0o700 });
    const taken = new Set<string>();
    for (let name = await freeName(input.chatId, input.home, input.gitCommonDir); name !== null; name = await freeName(input.chatId, input.home, input.gitCommonDir, taken)) {
      const worktree = join(worktreesRoot(input.home), name);
      const branch = `piop/${name}`;
      input.save(worktree, branch);
      try { await mkdir(worktree, { mode: 0o700 }); return { worktree, branch }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; taken.add(name); }
    }
    throw new Error(`No free worktree name for chat ${input.chatId}`);
  });
}

export function archiveRef(id: string): string {
  return `refs/piop/archives/${chatId(id)}`;
}

/** The commit that the archive reference of a chat names, or null when the reference does not exist. Read only. */
export async function archivedCommit(input: { chatId: string; gitCommonDir: string }): Promise<string | null> {
  const ref = archiveRef(input.chatId);
  return serialized(input.gitCommonDir, () => commitOf(input.gitCommonDir, ref));
}

/** The chat worktree record names the folder; this checks that it is a Piop worktree folder name in the Piop worktrees folder. */
function requireOwnedFolder(home: string, id: string, worktree: string): void {
  if (dirname(worktree) !== worktreesRoot(home) || !NAME.test(basename(worktree))) throw new Error(`Not a worktree folder of chat ${id} in ${worktreesRoot(home)}: ${worktree}`);
}

function requireOwnedBranch(id: string, branch: string): void {
  if (!branch.startsWith('piop/') || !NAME.test(branch.slice(5))) throw new Error(`Not a branch of chat ${id}: ${branch}`);
}

/** Finds the repository that holds `cwd`. Returns null outside Git; throws for any other Git failure. */
export async function detectRepository(cwd: string): Promise<Repository | null> {
  const probe = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allow: [128] });
  if (probe.code !== 0) {
    if (/not a git repository/i.test(probe.stderr)) return null;
    throw new GitError(`Could not check for a Git repository in ${cwd}: ${probe.stderr.trim()}`, ['rev-parse'], probe.code, probe.stderr);
  }
  if (probe.stdout.trim() !== 'true') return null;
  if (await realpath(cwd) !== await topLevel(cwd)) return null;
  const gitCommonDir = await realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
  const main = (await worktrees(gitCommonDir))[0];
  if (!main) throw new Error(`Could not find the main worktree of ${gitCommonDir}`);
  return { repository: await realpath(main.path), gitCommonDir };
}

export async function newChatBranches(cwd: string): Promise<{ repository: string; branches: string[]; defaultBranch: string | null } | null> {
  const repository = await detectRepository(cwd);
  if (!repository) return null;
  return serialized(repository.gitCommonDir, async () => {
    const branches = (await git(repository.gitCommonDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/'])).stdout.trim().split('\n').filter(Boolean);
    const current = await git(repository.repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allow: [1] });
    return { repository: repository.repository, branches, defaultBranch: current.code === 0 && branches.includes(current.stdout.trim()) ? current.stdout.trim() : null };
  });
}

async function required(cwd: string, known: Repository | undefined, action: string): Promise<Repository> {
  const repository = known ?? await detectRepository(cwd);
  if (!repository) throw new Error(`Cannot ${action} outside a Git repository: ${cwd}`);
  return repository;
}

type Listed = { path: string; branch: string | null };

async function worktrees(gitCommonDir: string): Promise<Listed[]> {
  const list: Listed[] = [];
  for (const line of (await git(gitCommonDir, ['worktree', 'list', '--porcelain'])).stdout.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice(9), branch: null });
    else if (line.startsWith('branch refs/heads/') && list.length) list[list.length - 1].branch = line.slice(18);
  }
  return list;
}

async function topLevel(cwd: string): Promise<string> {
  return realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim());
}

async function commitOf(cwd: string, ref: string): Promise<string | null> {
  const run = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allow: [1] });
  return run.code === 0 ? run.stdout.trim() : null;
}

/**
 * Commits every change in the worktree holding `cwd`, using `git add .` from its root. Returns null when nothing
 * changed. Ignored untracked files stay out; tracked files stay tracked. Pass the cached `repository` to skip
 * detection; Git still fails loudly when `cwd` stopped being a repository.
 */
export async function saveProgress(cwd: string, repository?: Repository): Promise<{ commit: string } | null> {
  const { gitCommonDir } = await required(cwd, repository, 'save progress');
  return serialized(gitCommonDir, async () => {
    const root = await topLevel(cwd);
    await git(root, ['add', '.']);
    if ((await git(root, ['diff', '--cached', '--quiet'], { allow: [1] })).code === 0) return null;
    await git(root, ['commit', '--quiet', '-m', SAVE_MESSAGE]);
    const commit = await commitOf(root, 'HEAD');
    if (!commit) throw new Error(`Committed progress in ${root} but HEAD is missing`);
    return { commit };
  });
}

/** Checks out into `worktree`, an empty folder that the caller claimed with mkdir. */
async function checkOut(gitCommonDir: string, worktree: string, args: string[]): Promise<string> {
  if ((await readdir(worktree)).length) throw new Error(`Worktree folder is not empty: ${worktree}`);
  await git(gitCommonDir, ['worktree', 'add', '--quiet', ...args]);
  return realpath(worktree);
}

/**
 * Checks out the folder that `claimWorktree` claimed, on its new branch at the source HEAD or at baseBranch. Only committed
 * files are copied; the source keeps its files, index and HEAD. Refuses an existing branch. On failure, removes the folder
 * and branch; later steps undo it with `removeCreatedWorktree`.
 */
export async function createWorktree(input: { sourceCwd: string; chatId: string; home: string; worktree: string; branch: string; repository?: Repository; baseBranch?: string }): Promise<CreatedWorktree> {
  const { worktree, branch } = input;
  requireOwnedFolder(input.home, input.chatId, worktree);
  requireOwnedBranch(input.chatId, branch);
  const repository = await required(input.sourceCwd, input.repository, 'branch a chat');
  return serialized(repository.gitCommonDir, async () => {
    // The branch is someone else's, so only the claimed folder is removed.
    if (await commitOf(repository.gitCommonDir, `refs/heads/${branch}`)) { await removeFolder(repository.gitCommonDir, input.home, input.chatId, worktree); throw new Error(`Branch already exists: ${branch}`); }
    // The claimed folder exists from here on, so every failure below removes it.
    try {
      const root = await topLevel(input.sourceCwd);
      let ref = 'HEAD';
      if (input.baseBranch !== undefined) {
        const branches = (await git(repository.gitCommonDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/'])).stdout.trim().split('\n');
        if (!branches.includes(input.baseBranch)) throw new Error(`Branch does not exist: ${input.baseBranch}`);
        ref = input.baseBranch;
      }
      const commit = await commitOf(root, ref);
      if (!commit) throw new Error(`Cannot branch a chat from ${ref}: no commit found`);
      const made = await checkOut(repository.gitCommonDir, worktree, ['-b', branch, worktree, commit]);
      return { ...repository, chatId: input.chatId, worktree: made, branch, commit };
    } catch (error) {
      try {
        await both(
          () => removeFolder(repository.gitCommonDir, input.home, input.chatId, worktree),
          () => removeBranch(repository.gitCommonDir, input.chatId, branch),
        );
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], `${(error as Error).message}; cleanup also failed: ${(cleanup as Error).message}`);
      }
      throw error;
    }
  });
}

/**
 * Removes the folder if Git lists it as a worktree of the repository. A missing folder is done; any other folder is kept
 * and reported. The folder is first renamed to a Piop trash name (`.removing-<folder>-<uuid>`) in the same parent, so
 * Git forgets it in one step and a removal that fails part way is finished by the next call.
 */
async function removeFolder(gitCommonDir: string, home: string, id: string, worktree: string): Promise<void> {
  requireOwnedFolder(home, id, worktree);
  // A claimed folder that Git never checked out into is still empty.
  if (await exists(worktree) && !(await readdir(worktree)).length) await rmdir(worktree);
  if (await exists(worktree)) {
    const real = await realpath(worktree);
    const listed = await worktrees(gitCommonDir);
    if (!listed.some(item => item.path === real || item.path === worktree)) throw new Error(`${worktree} is not a worktree of ${gitCommonDir}; it was kept`);
    await rename(worktree, join(dirname(worktree), `.removing-${basename(worktree)}-${randomUUID()}`));
  }
  await git(gitCommonDir, ['worktree', 'prune']);
  await removeTrash(dirname(worktree), basename(worktree));
}

/** Deletes every trash folder of one worktree folder name. Makes read-only parts writable first; they are Piop's own. */
async function removeTrash(parent: string, name: string): Promise<void> {
  const pattern = new RegExp(`^\\.removing-${name}-${UUID}$`);
  const failures: unknown[] = [];
  let entries: string[];
  try { entries = await readdir(parent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const trash = join(parent, entry);
    try {
      try { await rm(trash, { recursive: true, force: true }); }
      catch (error) {
        if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await makeWritable(trash);
        await rm(trash, { recursive: true, force: true });
      }
    } catch (error) { failures.push(new Error(`Could not remove ${trash}: ${(error as Error).message}`)); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, (failures as Error[]).map(error => error.message).join('; '));
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory()) return;
  await chmod(path, (info.mode & 0o7777) | 0o700);
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}

/** Deletes a chat branch. A missing branch is done; a branch checked out in a worktree is kept and reported. */
async function removeBranch(gitCommonDir: string, id: string, branch: string): Promise<void> {
  requireOwnedBranch(id, branch);
  if (!await commitOf(gitCommonDir, `refs/heads/${branch}`)) return;
  const user = (await worktrees(gitCommonDir)).find(item => item.branch === branch);
  if (user) throw new Error(`Branch ${branch} is checked out in ${user.path}; it was kept`);
  await git(gitCommonDir, ['branch', '--quiet', '-D', branch]);
}

/** Deletes `ref` only while it points to `commit`. A missing ref is done. */
async function removeRef(gitCommonDir: string, ref: string, commit: string): Promise<void> {
  const current = await commitOf(gitCommonDir, ref);
  if (current === null) return;
  if (current !== commit) throw new Error(`${ref} moved to ${current}; it was kept`);
  await git(gitCommonDir, ['update-ref', '--no-deref', '-d', ref, commit]);
}

async function both(first: () => Promise<void>, second: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of [first, second]) { try { await step(); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, (failures as Error[]).map(error => error.message).join('; '));
}

/** Undoes `claimWorktree` and `createWorktree`: removes the claimed folder and branch. Idempotent. */
export async function removeCreatedWorktree(input: { chatId: string; gitCommonDir: string; home: string; worktree: string; branch: string }): Promise<void> {
  const { chatId: id, gitCommonDir, home } = input;
  await serialized(gitCommonDir, () => both(
    () => removeFolder(gitCommonDir, home, id, input.worktree),
    () => removeBranch(gitCommonDir, id, input.branch),
  ));
}

/**
 * Protects the last commit of the worktree with `refs/piop/archives/<chatId>`. Idempotent: an existing ref is
 * accepted when it already points to that commit, or when the folder is gone after an earlier archive step.
 */
export async function protectArchive(input: { worktree: ChatWorktree; home: string }): Promise<ChatArchive> {
  const record = input.worktree;
  requireOwnedFolder(input.home, record.chatId, record.worktree);
  const ref = archiveRef(record.chatId);
  return serialized(record.gitCommonDir, async () => {
    const existing = await commitOf(record.gitCommonDir, ref);
    if (!await exists(record.worktree)) {
      if (existing) return { ...record, ref, commit: existing };
      throw new Error(`Worktree folder is missing and nothing was archived: ${record.worktree}`);
    }
    const commit = await commitOf(record.worktree, 'HEAD');
    if (!commit) throw new Error(`Worktree has no commit to archive: ${record.worktree}`);
    if (existing && existing !== commit) throw new Error(`${ref} already points to ${existing}`);
    if (!existing) await git(record.gitCommonDir, ['update-ref', '--no-deref', '-m', 'piop: archive chat', ref, commit, '']);
    if (await commitOf(record.gitCommonDir, ref) !== commit) throw new Error(`${ref} was not saved`);
    return { ...record, ref, commit };
  });
}

export async function removeArchivedWorktree(input: { archive: ChatArchive; home: string }): Promise<void> {
  const { archive, home } = input;
  await serialized(archive.gitCommonDir, async () => {
    if (await commitOf(archive.gitCommonDir, archive.ref) !== archive.commit) throw new Error(`${archive.ref} does not protect ${archive.commit}; the worktree was kept`);
    await removeFolder(archive.gitCommonDir, home, archive.chatId, archive.worktree);
    await removeBranch(archive.gitCommonDir, archive.chatId, archive.branch);
  });
}

/**
 * Decides where a restore puts the worktree, without changing anything. Keeps the previous folder name when it is free,
 * and the branch when no worktree has it and it is gone or still points to the archived commit. Otherwise takes the
 * shortest free start of the chat ID, as `claimWorktree` does. `restoreWorktree` claims the folder with mkdir.
 */
export async function planRestore(input: { archive: ChatArchive; home: string; retainShared?: boolean }): Promise<RestorePlan> {
  const { archive, home } = input;
  return serialized(archive.gitCommonDir, async () => {
    await requireArchive(archive);
    const restoreId = randomUUID();
    if (input.retainShared && await exists(archive.worktree)) {
      requireOwnedFolder(home, archive.chatId, archive.worktree);
      const real = await realpath(archive.worktree);
      if (!(await worktrees(archive.gitCommonDir)).some(item => item.path === real)) throw new Error(`Shared folder is not a worktree of ${archive.gitCommonDir}: ${archive.worktree}`);
      return { restoreId, worktree: archive.worktree, branch: archive.branch, reuse: true, retained: true };
    }
    const inUse = (await worktrees(archive.gitCommonDir)).some(item => item.branch === archive.branch);
    const branchCommit = await commitOf(archive.gitCommonDir, `refs/heads/${archive.branch}`);
    const reuse = !inUse && branchCommit === archive.commit;
    const keepBranch = !inUse && (!branchCommit || reuse);
    const keepFolder = !await exists(archive.worktree);
    if (keepFolder && keepBranch) return { restoreId, worktree: archive.worktree, branch: archive.branch, reuse };
    const name = await freeName(archive.chatId, home, archive.gitCommonDir);
    if (name === null) throw new Error(`No free worktree name for chat ${archive.chatId}`);
    return { restoreId, worktree: keepFolder ? archive.worktree : join(worktreesRoot(home), name), branch: keepBranch ? archive.branch : `piop/${name}`, reuse: keepBranch && reuse };
  });
}

async function requireArchive(archive: ChatArchive): Promise<void> {
  if (!COMMIT.test(archive.commit)) throw new Error(`Archived commit is not a full hash: ${archive.commit}`);
  if (archive.ref !== archiveRef(archive.chatId)) throw new Error(`Not the archive reference of chat ${archive.chatId}: ${archive.ref}`);
  const current = await commitOf(archive.gitCommonDir, archive.ref);
  if (current !== archive.commit) throw new Error(`${archive.ref} does not point to ${archive.commit}`);
}

/** Carries out `plan` exactly. Keeps the archive reference; release it with `releaseArchive`. Undo with `removeRestoredWorktree`. */
export async function restoreWorktree(input: { archive: ChatArchive; home: string; plan: RestorePlan }): Promise<ChatWorktree> {
  const { archive, home, plan } = input;
  requireOwnedFolder(home, archive.chatId, plan.worktree);
  requireOwnedBranch(archive.chatId, plan.branch);
  return serialized(archive.gitCommonDir, async () => {
    await requireArchive(archive);
    if (plan.retained) {
      if (plan.worktree !== archive.worktree || plan.branch !== archive.branch || !plan.reuse) throw new Error('Invalid shared worktree restore');
      const real = await realpath(plan.worktree);
      if (!(await worktrees(archive.gitCommonDir)).some(item => item.path === real)) throw new Error(`Shared worktree is missing: ${plan.worktree}`);
      return { ...archive };
    }
    if (plan.reuse) {
      if (plan.branch !== archive.branch || await commitOf(archive.gitCommonDir, `refs/heads/${plan.branch}`) !== archive.commit) throw new Error(`Branch ${plan.branch} no longer points to ${archive.commit}`);
    } else if (await commitOf(archive.gitCommonDir, `refs/heads/${plan.branch}`)) throw new Error(`Branch already exists: ${plan.branch}`);
    await mkdir(worktreesRoot(home), { recursive: true, mode: 0o700 });
    try { await mkdir(plan.worktree, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Worktree folder was taken by another chat; restore again: ${plan.worktree}`); throw error; }
    const made = await checkOut(archive.gitCommonDir, plan.worktree, plan.reuse ? [plan.worktree, plan.branch] : ['-b', plan.branch, plan.worktree, archive.commit]);
    return { repository: archive.repository, gitCommonDir: archive.gitCommonDir, chatId: archive.chatId, worktree: made, branch: plan.branch };
  });
}

/** Undoes `restoreWorktree`: removes the planned folder, and the planned branch when it was new. Idempotent. */
export async function removeRestoredWorktree(input: { archive: ChatArchive; home: string; plan: RestorePlan }): Promise<void> {
  const { archive, home, plan } = input;
  if (plan.retained) return;
  await serialized(archive.gitCommonDir, () => both(
    () => removeFolder(archive.gitCommonDir, home, archive.chatId, plan.worktree),
    async () => { if (!plan.reuse) await removeBranch(archive.gitCommonDir, archive.chatId, plan.branch); },
  ));
}

/** Deletes the archive reference while it still points to the archived commit. Idempotent. */
export async function releaseArchive(archive: ChatArchive): Promise<void> {
  await serialized(archive.gitCommonDir, () => removeRef(archive.gitCommonDir, archiveRef(archive.chatId), archive.commit));
}

/**
 * Permanently deletes what a chat holds in Git: its folder, its archive reference (only while it points to the saved
 * commit) and its branch (only while no worktree has it checked out). Idempotent. Reports every part it kept.
 */
export async function deleteChatWorktree(input: { record: ChatWorktree & { archive: null | { ref: string; commit: string } }; home: string }): Promise<void> {
  const { record, home } = input;
  await serialized(record.gitCommonDir, async () => {
    const failures: unknown[] = [];
    const steps = [
      () => removeFolder(record.gitCommonDir, home, record.chatId, record.worktree),
      async () => { if (record.archive) await removeRef(record.gitCommonDir, archiveRef(record.chatId), record.archive.commit); },
      () => removeBranch(record.gitCommonDir, record.chatId, record.branch),
    ];
    for (const step of steps) { try { await step(); } catch (error) { failures.push(error); } }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, (failures as Error[]).map(error => error.message).join('; '));
  });
}
