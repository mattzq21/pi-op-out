import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
export type RestorePlan = { restoreId: string; worktree: string; branch: string; reuse: boolean };

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

/** The folder of a chat worktree: `<home>/.local/share/piop/worktrees/<chatId>`, or `<chatId>-<restoreId>`. */
export function worktreePath(home: string, id: string, restoreId?: string): string {
  return join(worktreesRoot(home), restoreId ? `${chatId(id)}-${chatId(restoreId)}` : chatId(id));
}

/** The branch of a chat: `piop/<chatId>`, or `piop/<chatId>-<restoreId>`. */
export function branchName(id: string, restoreId?: string): string {
  return restoreId ? `piop/${chatId(id)}-${chatId(restoreId)}` : `piop/${chatId(id)}`;
}

export function archiveRef(id: string): string {
  return `refs/piop/archives/${chatId(id)}`;
}

function ownedName(id: string, name: string, prefix = ''): boolean {
  return new RegExp(`^${prefix}${chatId(id)}(-${UUID})?$`).test(name);
}

function requireOwnedFolder(home: string, id: string, worktree: string): void {
  if (dirname(worktree) !== worktreesRoot(home) || !ownedName(id, basename(worktree))) throw new Error(`Not a worktree folder of chat ${id} in ${worktreesRoot(home)}: ${worktree}`);
}

function requireOwnedBranch(id: string, branch: string): void {
  if (!ownedName(id, branch, 'piop/')) throw new Error(`Not a branch of chat ${id}: ${branch}`);
}

/** Finds the repository that holds `cwd`. Returns null outside Git; throws for any other Git failure. */
export async function detectRepository(cwd: string): Promise<Repository | null> {
  const probe = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allow: [128] });
  if (probe.code !== 0) {
    if (/not a git repository/i.test(probe.stderr)) return null;
    throw new GitError(`Could not check for a Git repository in ${cwd}: ${probe.stderr.trim()}`, ['rev-parse'], probe.code, probe.stderr);
  }
  if (probe.stdout.trim() !== 'true') return null;
  const gitCommonDir = await realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
  const main = (await worktrees(gitCommonDir))[0];
  if (!main) throw new Error(`Could not find the main worktree of ${gitCommonDir}`);
  return { repository: await realpath(main.path), gitCommonDir };
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

/**
 * Writes the current files of `root` as a tree through a private index, so the source keeps its files, index and
 * HEAD. Includes tracked changes, deletions and untracked files that are not ignored.
 */
async function currentTree(root: string, parent: string | null): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'piop-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    if (parent) await git(root, ['read-tree', parent], { env });
    await git(root, ['add', '--all', '.'], { env });
    return (await git(root, ['write-tree'], { env })).stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function checkOut(gitCommonDir: string, worktree: string, args: string[]): Promise<string> {
  if (await exists(worktree)) throw new Error(`Worktree folder already exists: ${worktree}`);
  await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
  await git(gitCommonDir, ['worktree', 'add', '--quiet', ...args]);
  return realpath(worktree);
}

/**
 * Checks out `worktreePath(home, chatId)` on a new branch `piop/<chatId>` at the source HEAD, then copies the current
 * files of the worktree at `sourceCwd` in as uncommitted changes: modified, deleted and untracked files, without
 * ignored files. The source keeps its files, index and HEAD. Refuses an existing folder or branch. On failure, removes
 * the folder and branch it made; later steps undo it with `removeCreatedWorktree`.
 */
export async function createWorktree(input: { sourceCwd: string; chatId: string; home: string; repository?: Repository }): Promise<CreatedWorktree> {
  const worktree = worktreePath(input.home, input.chatId);
  const branch = branchName(input.chatId);
  const repository = await required(input.sourceCwd, input.repository, 'branch a chat');
  return serialized(repository.gitCommonDir, async () => {
    if (await commitOf(repository.gitCommonDir, `refs/heads/${branch}`)) throw new Error(`Branch already exists: ${branch}`);
    if (await exists(worktree)) throw new Error(`Worktree folder already exists: ${worktree}`);
    const root = await topLevel(input.sourceCwd);
    const commit = await commitOf(root, 'HEAD');
    if (!commit) throw new Error(`Cannot branch a chat from a repository without commits: ${root}`);
    const tree = await currentTree(root, commit);
    try {
      const made = await checkOut(repository.gitCommonDir, worktree, ['-b', branch, worktree, commit]);
      await git(made, ['read-tree', '-u', '--reset', tree]);
      await git(made, ['reset', '--quiet']);
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

/** Removes the folder if Git lists it as a worktree of the repository. A missing folder is done; any other folder is kept and reported. */
async function removeFolder(gitCommonDir: string, home: string, id: string, worktree: string): Promise<void> {
  requireOwnedFolder(home, id, worktree);
  if (!await exists(worktree)) {
    await git(gitCommonDir, ['worktree', 'prune']);
    return;
  }
  const real = await realpath(worktree);
  const listed = await worktrees(gitCommonDir);
  if (!listed.some(item => item.path === real || item.path === worktree)) throw new Error(`${worktree} is not a worktree of ${gitCommonDir}; it was kept`);
  await git(gitCommonDir, ['worktree', 'remove', '--force', '--force', worktree]);
  if (await exists(worktree)) throw new Error(`Worktree folder remains: ${worktree}`);
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

/** Undoes `createWorktree`: removes its folder and `piop/<chatId>`. Idempotent. */
export async function removeCreatedWorktree(input: { chatId: string; gitCommonDir: string; home: string }): Promise<void> {
  const { chatId: id, gitCommonDir, home } = input;
  await serialized(gitCommonDir, () => both(
    () => removeFolder(gitCommonDir, home, id, worktreePath(home, id)),
    () => removeBranch(gitCommonDir, id, branchName(id)),
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

/** Removes the folder of an archived chat after `protectArchive`. Keeps the branch. Changes after the commit are discarded. */
export async function removeArchivedWorktree(input: { archive: ChatArchive; home: string }): Promise<void> {
  const { archive, home } = input;
  await serialized(archive.gitCommonDir, async () => {
    if (await commitOf(archive.gitCommonDir, archive.ref) !== archive.commit) throw new Error(`${archive.ref} does not protect ${archive.commit}; the worktree was kept`);
    await removeFolder(archive.gitCommonDir, home, archive.chatId, archive.worktree);
  });
}

/**
 * Decides where a restore puts the worktree, without changing anything. Reuses the branch when it still points to the
 * archived commit and no worktree has it; otherwise `branchName(chatId, restoreId)`. Reuses the previous folder when
 * free; otherwise `worktreePath(home, chatId, restoreId)`.
 */
export async function planRestore(input: { archive: ChatArchive; home: string }): Promise<RestorePlan> {
  const { archive, home } = input;
  return serialized(archive.gitCommonDir, async () => {
    await requireArchive(archive);
    const restoreId = randomUUID();
    const inUse = (await worktrees(archive.gitCommonDir)).some(item => item.branch === archive.branch);
    const reuse = !inUse && await commitOf(archive.gitCommonDir, `refs/heads/${archive.branch}`) === archive.commit;
    const preferred = worktreePath(home, archive.chatId);
    return {
      restoreId,
      worktree: await exists(preferred) ? worktreePath(home, archive.chatId, restoreId) : preferred,
      branch: reuse ? archive.branch : branchName(archive.chatId, restoreId),
      reuse,
    };
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
    if (plan.reuse) {
      if (plan.branch !== archive.branch || await commitOf(archive.gitCommonDir, `refs/heads/${plan.branch}`) !== archive.commit) throw new Error(`Branch ${plan.branch} no longer points to ${archive.commit}`);
    } else if (await commitOf(archive.gitCommonDir, `refs/heads/${plan.branch}`)) throw new Error(`Branch already exists: ${plan.branch}`);
    const made = await checkOut(archive.gitCommonDir, plan.worktree, plan.reuse ? [plan.worktree, plan.branch] : ['-b', plan.branch, plan.worktree, archive.commit]);
    return { repository: archive.repository, gitCommonDir: archive.gitCommonDir, chatId: archive.chatId, worktree: made, branch: plan.branch };
  });
}

/** Undoes `restoreWorktree`: removes the planned folder, and the planned branch when it was new. Idempotent. */
export async function removeRestoredWorktree(input: { archive: ChatArchive; home: string; plan: RestorePlan }): Promise<void> {
  const { archive, home, plan } = input;
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
