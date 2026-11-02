import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHAT_ID = new RegExp(`^${UUID}$`);
const NAME = new RegExp(`^([0-9a-f]{4,32}|${UUID}(-${UUID})?)$`);
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export type Repository = { repository: string; gitCommonDir: string };
export type ChatWorktree = Repository & { chatId: string; worktree: string; branch: string };
export type CreatedWorktree = ChatWorktree & { commit: string };
export type ChatArchive = ChatWorktree & { ref: string; commit: string; base: string };
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
  return join(home, STORAGE_DIRECTORY, 'worktrees');
}

function names(id: string): string[] {
  const hex = chatId(id).replaceAll('-', '');
  return Array.from({ length: hex.length - 3 }, (_, index) => hex.slice(0, index + 4));
}

async function freeName(id: string, home: string, gitCommonDir: string, taken: Set<string>): Promise<string | null> {
  for (const name of names(id)) {
    if (taken.has(name) || await exists(join(worktreesRoot(home), name)) || await commitOf(gitCommonDir, `refs/heads/piop/${name}`)) continue;
    return name;
  }
  return null;
}

export async function claimWorktree(input: { chatId: string; home: string; gitCommonDir: string; taken: () => Set<string>; save: (worktree: string, branch: string) => void }): Promise<{ worktree: string; branch: string }> {
  return serialized(input.gitCommonDir, async () => {
    await mkdir(worktreesRoot(input.home), { recursive: true, mode: 0o700 });
    const taken = input.taken();
    for (let name = await freeName(input.chatId, input.home, input.gitCommonDir, taken); name !== null; name = await freeName(input.chatId, input.home, input.gitCommonDir, taken)) {
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

export async function archivedCommit(input: { chatId: string; gitCommonDir: string }): Promise<string | null> {
  const ref = archiveRef(input.chatId);
  return serialized(input.gitCommonDir, () => commitOf(input.gitCommonDir, ref));
}

function requireOwnedFolder(home: string, id: string, worktree: string): void {
  if (dirname(worktree) !== worktreesRoot(home) || !NAME.test(basename(worktree))) throw new Error(`Not a worktree folder of chat ${id} in ${worktreesRoot(home)}: ${worktree}`);
}

function requireOwnedBranch(id: string, branch: string): void {
  if (!branch.startsWith('piop/') || !NAME.test(branch.slice(5))) throw new Error(`Not a branch of chat ${id}: ${branch}`);
}

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

async function checkOut(gitCommonDir: string, worktree: string, args: string[]): Promise<string> {
  if ((await readdir(worktree)).length) throw new Error(`Worktree folder is not empty: ${worktree}`);
  await git(gitCommonDir, ['worktree', 'add', '--quiet', ...args]);
  return realpath(worktree);
}

export async function createWorktree(input: { sourceCwd: string; chatId: string; home: string; worktree: string; branch: string; repository?: Repository; baseBranch?: string }): Promise<CreatedWorktree> {
  const { worktree, branch } = input;
  requireOwnedFolder(input.home, input.chatId, worktree);
  requireOwnedBranch(input.chatId, branch);
  const repository = await required(input.sourceCwd, input.repository, 'branch a chat');
  return serialized(repository.gitCommonDir, async () => {
    if (await commitOf(repository.gitCommonDir, `refs/heads/${branch}`)) { await removeFolder(repository.gitCommonDir, input.home, input.chatId, worktree); throw new Error(`Branch already exists: ${branch}`); }
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

async function removeFolder(gitCommonDir: string, home: string, id: string, worktree: string): Promise<void> {
  requireOwnedFolder(home, id, worktree);
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

async function removeBranch(gitCommonDir: string, id: string, branch: string): Promise<void> {
  requireOwnedBranch(id, branch);
  if (!await commitOf(gitCommonDir, `refs/heads/${branch}`)) return;
  const user = (await worktrees(gitCommonDir)).find(item => item.branch === branch);
  if (user) throw new Error(`Branch ${branch} is checked out in ${user.path}; it was kept`);
  await git(gitCommonDir, ['branch', '--quiet', '-D', branch]);
}

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

export async function removeCreatedWorktree(input: { chatId: string; gitCommonDir: string; home: string; worktree: string; branch: string }): Promise<void> {
  const { chatId: id, gitCommonDir, home } = input;
  await serialized(gitCommonDir, () => both(
    () => removeFolder(gitCommonDir, home, id, input.worktree),
    () => removeBranch(gitCommonDir, id, input.branch),
  ));
}

const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: 'Piop', GIT_AUTHOR_EMAIL: 'piop@localhost', GIT_COMMITTER_NAME: 'Piop', GIT_COMMITTER_EMAIL: 'piop@localhost' };

async function snapshotTree(root: string): Promise<string> {
  const index = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim();
  const temporary = `${index}.piop-${randomUUID()}`;
  try {
    try { await copyFile(index, temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const env = { GIT_INDEX_FILE: temporary };
    await git(root, ['add', '--all', '--', '.'], { env });
    return (await git(root, ['write-tree'], { env })).stdout.trim();
  } finally { await rm(temporary, { force: true }); }
}

async function snapshot(root: string, base: string, existing: string | null): Promise<string> {
  const tree = await snapshotTree(root);
  if (tree === (await git(root, ['rev-parse', `${base}^{tree}`])).stdout.trim()) return base;
  if (existing && (await git(root, ['rev-parse', `${existing}^{tree}`, `${existing}^@`])).stdout.trim() === `${tree}\n${base}`) return existing;
  return (await git(root, ['commit-tree', '--no-gpg-sign', '-p', base, '-m', 'Piop archive snapshot', tree], { env: SNAPSHOT_IDENTITY })).stdout.trim();
}

export async function protectArchive(input: { worktree: ChatWorktree; home: string }): Promise<ChatArchive> {
  const record = input.worktree;
  requireOwnedFolder(input.home, record.chatId, record.worktree);
  const ref = archiveRef(record.chatId);
  return serialized(record.gitCommonDir, async () => {
    if (!await exists(record.worktree)) throw new Error(`Worktree folder is missing and nothing was archived: ${record.worktree}`);
    const base = await commitOf(record.worktree, 'HEAD');
    if (!base) throw new Error(`Worktree has no commit to archive: ${record.worktree}`);
    const existing = await commitOf(record.gitCommonDir, ref);
    const commit = await snapshot(record.worktree, base, existing);
    if (existing && existing !== commit) throw new Error(`${ref} already points to ${existing}`);
    if (!existing) await git(record.gitCommonDir, ['update-ref', '--no-deref', '-m', 'piop: archive chat', ref, commit, '']);
    if (await commitOf(record.gitCommonDir, ref) !== commit) throw new Error(`${ref} was not saved`);
    return { ...record, ref, commit, base };
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

export async function planRestore(input: { archive: ChatArchive; home: string; retainShared?: boolean; taken: () => Set<string>; save: (plan: RestorePlan) => void }): Promise<RestorePlan> {
  const { archive, home } = input;
  return serialized(archive.gitCommonDir, async () => {
    const plan = await choosePlan(archive, home, input);
    input.save(plan);
    return plan;
  });
}

async function choosePlan(archive: ChatArchive, home: string, input: { retainShared?: boolean; taken: () => Set<string> }): Promise<RestorePlan> {
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
  const reuse = !inUse && branchCommit === archive.base;
  const keepBranch = !inUse && (!branchCommit || reuse);
  const keepFolder = !await exists(archive.worktree);
  if (keepFolder && keepBranch) return { restoreId, worktree: archive.worktree, branch: archive.branch, reuse };
  const name = await freeName(archive.chatId, home, archive.gitCommonDir, input.taken());
  if (name === null) throw new Error(`No free worktree name for chat ${archive.chatId}`);
  return { restoreId, worktree: keepFolder ? archive.worktree : join(worktreesRoot(home), name), branch: keepBranch ? archive.branch : `piop/${name}`, reuse: keepBranch && reuse };
}

async function requireArchive(archive: ChatArchive): Promise<void> {
  if (!COMMIT.test(archive.commit) || !COMMIT.test(archive.base)) throw new Error(`Archived commit is not a full hash: ${archive.commit} ${archive.base}`);
  if (archive.ref !== archiveRef(archive.chatId)) throw new Error(`Not the archive reference of chat ${archive.chatId}: ${archive.ref}`);
  const current = await commitOf(archive.gitCommonDir, archive.ref);
  if (current !== archive.commit) throw new Error(`${archive.ref} does not point to ${archive.commit}`);
  if (archive.commit !== archive.base && (await git(archive.gitCommonDir, ['rev-parse', `${archive.commit}^@`])).stdout.trim() !== archive.base) throw new Error(`Archived snapshot ${archive.commit} is not based on ${archive.base}`);
}

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
      if (plan.branch !== archive.branch || await commitOf(archive.gitCommonDir, `refs/heads/${plan.branch}`) !== archive.base) throw new Error(`Branch ${plan.branch} no longer points to ${archive.base}`);
    } else if (await commitOf(archive.gitCommonDir, `refs/heads/${plan.branch}`)) throw new Error(`Branch already exists: ${plan.branch}`);
    await mkdir(worktreesRoot(home), { recursive: true, mode: 0o700 });
    try { await mkdir(plan.worktree, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Worktree folder was taken by another chat; restore again: ${plan.worktree}`); throw error; }
    const made = await checkOut(archive.gitCommonDir, plan.worktree, plan.reuse ? [plan.worktree, plan.branch] : ['-b', plan.branch, plan.worktree, archive.base]);
    if (archive.commit !== archive.base) await git(made, ['restore', '--source', archive.commit, '--worktree', '--', '.']);
    return { repository: archive.repository, gitCommonDir: archive.gitCommonDir, chatId: archive.chatId, worktree: made, branch: plan.branch };
  });
}

export async function removeRestoredWorktree(input: { archive: ChatArchive; home: string; plan: RestorePlan }): Promise<void> {
  const { archive, home, plan } = input;
  if (plan.retained) return;
  await serialized(archive.gitCommonDir, () => both(
    () => removeFolder(archive.gitCommonDir, home, archive.chatId, plan.worktree),
    async () => { if (!plan.reuse) await removeBranch(archive.gitCommonDir, archive.chatId, plan.branch); },
  ));
}

export async function releaseArchive(archive: ChatArchive): Promise<void> {
  await serialized(archive.gitCommonDir, () => removeRef(archive.gitCommonDir, archiveRef(archive.chatId), archive.commit));
}

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
