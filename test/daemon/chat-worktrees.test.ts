import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'bun:test';
import * as Worktrees from '../../daemon/src/worktrees/worktrees';
import { temporaryDirectory } from './harness';

beforeAll(() => {
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Piop Test', GIT_AUTHOR_EMAIL: 'test@piop', GIT_COMMITTER_NAME: 'Piop Test', GIT_COMMITTER_EMAIL: 'test@piop',
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function repository(): { repo: string; home: string; base: string } {
  const base = realpathSync(temporaryDirectory('piop-worktrees-'));
  const repo = join(base, 'project');
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  write(join(repo, 'tracked.txt'), 'one\n');
  write(join(repo, 'gone.txt'), 'gone\n');
  write(join(repo, '.gitignore'), '*.log\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'start');
  const home = join(base, 'home');
  mkdirSync(home);
  return { repo, home, base };
}

function commitAll(root: string): string {
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Work');
  return git(root, 'rev-parse', 'HEAD');
}

function files(root: string): Record<string, string> {
  const listed = git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  return Object.fromEntries([...new Set(listed)].filter(name => existsSync(join(root, name))).sort().map(name => [name, readFileSync(join(root, name), 'utf8')]));
}

function status(root: string): string {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trimEnd();
}

function hasRef(repo: string, ref: string): boolean {
  try { git(repo, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
}

function short(chatId: string, n = 4): string { return chatId.replaceAll('-', '').slice(0, n); }

async function create(input: { sourceCwd: string; chatId: string; home: string; baseBranch?: string }) {
  const repository = await Worktrees.detectRepository(input.sourceCwd);
  if (!repository) return Worktrees.createWorktree({ ...input, worktree: join(Worktrees.worktreesRoot(input.home), short(input.chatId)), branch: 'piop/' + short(input.chatId) });
  const claimed = await Worktrees.claimWorktree({ chatId: input.chatId, home: input.home, gitCommonDir: repository.gitCommonDir, taken: () => new Set(), save: () => {} });
  return Worktrees.createWorktree({ ...input, ...claimed });
}

function makeDirty(repo: string): void {
  write(join(repo, 'tracked.txt'), 'two\n');
  write(join(repo, 'staged.txt'), 'staged\n');
  git(repo, 'add', 'staged.txt');
  git(repo, 'rm', '--quiet', 'gone.txt');
  write(join(repo, 'dir/new.txt'), 'new\n');
  write(join(repo, 'debug.log'), 'ignored\n');
}

test('detects repository roots and linked worktree roots, but not subfolders or folders outside Git', async () => {
  const { repo, base } = repository();
  mkdirSync(join(repo, 'sub'));
  const expected = { repository: repo, gitCommonDir: join(repo, '.git') };
  expect(await Worktrees.detectRepository(repo)).toEqual(expected);
  expect(await Worktrees.detectRepository(join(repo, 'sub'))).toBeNull();
  git(repo, 'worktree', 'add', '--quiet', join(base, 'linked'));
  expect(await Worktrees.detectRepository(join(base, 'linked'))).toEqual(expected);
  const outside = join(base, 'plain');
  mkdirSync(outside);
  expect(await Worktrees.detectRepository(outside)).toBeNull();
  await expect(Worktrees.detectRepository(join(base, 'missing'))).rejects.toThrow();
});

test('creates a chat worktree at the source commit with only the committed files, leaving the source unchanged', async () => {
  const { repo, home } = repository();
  makeDirty(repo);
  const before = { head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), files: files(repo), index: git(repo, 'ls-files', '--stage') };
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });

  const worktree = join(home, '.piop/worktrees', short(chatId));
  expect(created).toEqual({ repository: repo, gitCommonDir: join(repo, '.git'), chatId, worktree, branch: 'piop/' + short(chatId), commit: before.head });
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before.head);
  expect(git(worktree, 'branch', '--show-current')).toBe('piop/' + short(chatId));
  expect(git(worktree, 'ls-files').split('\n').sort()).toEqual(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort());
  expect(existsSync(join(worktree, 'debug.log'))).toBe(false);
  expect(existsSync(join(worktree, 'dir/new.txt'))).toBe(false);
  expect(status(worktree)).toBe('');
  expect({ head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), files: files(repo), index: git(repo, 'ls-files', '--stage') }).toEqual(before);
});

test('a taken folder or branch name makes the claim use one more digit, and leaves both untouched', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const folder = join(home, '.piop/worktrees', short(chatId));
  write(join(folder, 'keep.txt'), 'mine\n');
  const created = await create({ sourceCwd: repo, chatId, home });
  expect(created.worktree).toBe(join(home, '.piop/worktrees', short(chatId, 5)));
  expect(created.branch).toBe('piop/' + short(chatId, 5));
  expect(readFileSync(join(folder, 'keep.txt'), 'utf8')).toBe('mine\n');

  const other = randomUUID();
  git(repo, 'branch', 'piop/' + short(other));
  const second = await create({ sourceCwd: repo, chatId: other, home });
  expect(second.branch).toBe('piop/' + short(other, 5));
  expect(existsSync(join(home, '.piop/worktrees', short(other)))).toBe(false);
  expect(hasRef(repo, 'refs/heads/piop/' + short(other))).toBe(true);
  await expect(create({ sourceCwd: join(repo, '..'), chatId: randomUUID(), home })).rejects.toThrow(/outside a Git repository/);
});

test('a name another process claims first is skipped, and the claim is saved before its folder exists', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const saved: string[] = [];
  const claimed = await Worktrees.claimWorktree({ chatId, home, gitCommonDir: join(repo, '.git'), taken: () => new Set(), save: worktree => {
    saved.push(worktree);
    expect(existsSync(worktree)).toBe(false);
    if (saved.length === 1) mkdirSync(worktree);
  } });
  expect(saved).toEqual([join(Worktrees.worktreesRoot(home), short(chatId)), join(Worktrees.worktreesRoot(home), short(chatId, 5))]);
  expect(claimed).toEqual({ worktree: saved[1], branch: 'piop/' + short(chatId, 5) });
  expect(readdirSync(claimed.worktree)).toEqual([]);
  await expect(Worktrees.claimWorktree({ chatId: 'not-a-uuid', home, gitCommonDir: join(repo, '.git'), taken: () => new Set(), save: () => {} })).rejects.toThrow();
});

test('a failed creation removes the folder and branch it made', async () => {
  const { repo, home } = repository();
  write(join(repo, '.git/hooks/post-checkout'), '#!/bin/sh\necho checkout refused >&2\nexit 1\n');
  chmodSync(join(repo, '.git/hooks/post-checkout'), 0o755);
  const chatId = randomUUID();
  await expect(create({ sourceCwd: repo, chatId, home })).rejects.toThrow(/checkout refused/);
  expect(readdirSync(join(home, '.piop/worktrees'))).toEqual([]);
  expect(hasRef(repo, 'refs/heads/piop/' + short(chatId))).toBe(false);
  expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toEqual(['worktree ' + repo]);
});

test('removeCreatedWorktree undoes creation and repeats safely', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  write(join(created.worktree, 'scratch.txt'), 'x');
  await Worktrees.removeCreatedWorktree({ ...created, home });
  await Worktrees.removeCreatedWorktree({ ...created, home });
  expect(existsSync(created.worktree)).toBe(false);
  expect(hasRef(repo, 'refs/heads/' + created.branch)).toBe(false);
});

test('removes a worktree with read-only parts, and a later call finishes a removal that stopped part way', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  write(join(created.worktree, 'locked/inner.txt'), 'x');
  chmodSync(join(created.worktree, 'locked'), 0o555);
  const archive = await Worktrees.protectArchive({ worktree: created, home });
  await Worktrees.removeArchivedWorktree({ archive, home });
  expect(existsSync(created.worktree)).toBe(false);
  expect(readdirSync(join(home, '.piop/worktrees'))).toEqual([]);
  expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length).toBe(1);

  const leftover = join(home, '.piop/worktrees', `.removing-${short(chatId)}-${randomUUID()}`);
  write(join(leftover, 'locked/inner.txt'), 'x');
  chmodSync(join(leftover, 'locked'), 0o555);
  const other = join(home, '.piop/worktrees', `.removing-${randomUUID()}-${randomUUID()}`);
  mkdirSync(other);
  await Worktrees.removeArchivedWorktree({ archive, home });
  expect(existsSync(leftover)).toBe(false);
  expect(existsSync(other)).toBe(true);
});

test('undo and delete succeed when nothing was ever created on this machine', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const gitCommonDir = join(repo, '.git');
  expect(existsSync(join(home, '.piop/worktrees'))).toBe(false);
  const names = { worktree: join(Worktrees.worktreesRoot(home), short(chatId)), branch: 'piop/' + short(chatId) };
  await Worktrees.removeCreatedWorktree({ chatId, gitCommonDir, home, ...names });
  await Worktrees.deleteChatWorktree({ record: { repository: repo, gitCommonDir, chatId, ...names, archive: null }, home });
});

test('archive saves a snapshot of the current files, removes the folder and branch, and restore puts the files back on the last commit', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  write(join(created.worktree, 'work.txt'), 'saved\n');
  write(join(created.worktree, 'cache.log'), 'ignored\n');
  const saved = commitAll(created.worktree);
  write(join(created.worktree, 'work.txt'), 'after the commit\n');
  write(join(created.worktree, 'new.txt'), 'untracked\n');
  const index = git(created.worktree, 'ls-files', '--stage');

  const archive = await Worktrees.protectArchive({ worktree: created, home });
  const { commit: _branchCommit, ...fields } = created;
  expect(archive).toMatchObject({ ...fields, base: saved, ref: 'refs/piop/archives/' + chatId });
  expect(git(repo, 'rev-parse', archive.commit + '^@')).toBe(saved);
  expect(git(repo, 'log', '-1', '--format=%s', created.branch)).toBe('Work');
  expect(git(created.worktree, 'ls-files', '--stage')).toBe(index);
  expect(await Worktrees.protectArchive({ worktree: created, home })).toEqual(archive);
  await Worktrees.removeArchivedWorktree({ archive, home });
  await Worktrees.removeArchivedWorktree({ archive, home });
  expect(existsSync(created.worktree)).toBe(false);
  expect(hasRef(repo, 'refs/heads/' + created.branch)).toBe(false);
  git(repo, 'gc', '--quiet', '--prune=now');
  const plan = await Worktrees.planRestore({ archive, home, taken: () => new Set(), save: () => {} });
  expect(plan.reuse).toBe(false);
  expect(plan.branch).toBe(created.branch);
  expect(plan.worktree).toBe(created.worktree);
  const restored = await Worktrees.restoreWorktree({ archive, home, plan });
  expect(restored).toEqual({ repository: repo, gitCommonDir: created.gitCommonDir, chatId, worktree: created.worktree, branch: plan.branch });
  expect(git(restored.worktree, 'rev-parse', 'HEAD')).toBe(saved);
  expect(readFileSync(join(restored.worktree, 'work.txt'), 'utf8')).toBe('after the commit\n');
  expect(readFileSync(join(restored.worktree, 'new.txt'), 'utf8')).toBe('untracked\n');
  expect(existsSync(join(restored.worktree, 'cache.log'))).toBe(false);
  expect(status(restored.worktree)).toBe(' M work.txt\n?? new.txt');
  expect(hasRef(repo, archive.ref)).toBe(true);
  await Worktrees.releaseArchive(archive);
  await Worktrees.releaseArchive(archive);
  expect(hasRef(repo, archive.ref)).toBe(false);
});

test('archive reports a failed branch removal and can finish after the folder is gone', async () => {
  const { repo, home } = repository();
  const created = await create({ sourceCwd: repo, chatId: randomUUID(), home });
  const archive = await Worktrees.protectArchive({ worktree: created, home });
  const lock = join(created.gitCommonDir, 'refs/heads/' + created.branch + '.lock');
  write(lock, '');
  try {
    await expect(Worktrees.removeArchivedWorktree({ archive, home })).rejects.toThrow();
    expect(existsSync(created.worktree)).toBe(false);
    expect(hasRef(repo, 'refs/heads/' + created.branch)).toBe(true);
    expect(git(repo, 'rev-parse', archive.ref)).toBe(archive.commit);
  } finally { unlinkSync(lock); }
  await Worktrees.removeArchivedWorktree({ archive, home });
  expect(hasRef(repo, 'refs/heads/' + created.branch)).toBe(false);
  const plan = await Worktrees.planRestore({ archive, home, taken: () => new Set(), save: () => {} });
  const restored = await Worktrees.restoreWorktree({ archive, home, plan });
  expect(restored.branch).toBe(created.branch);
  expect(git(restored.worktree, 'rev-parse', 'HEAD')).toBe(archive.commit);
});

test('restore reuses an unchanged branch, and avoids a moved branch and an occupied folder', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  const archive = await Worktrees.protectArchive({ worktree: created, home });
  await Worktrees.removeArchivedWorktree({ archive, home });

  git(repo, 'branch', created.branch, archive.commit);
  const same = await Worktrees.planRestore({ archive, home, taken: () => new Set(), save: () => {} });
  expect(same).toMatchObject({ reuse: true, branch: created.branch, worktree: created.worktree });
  const reused = await Worktrees.restoreWorktree({ archive, home, plan: same });
  expect(git(reused.worktree, 'branch', '--show-current')).toBe(created.branch);
  await Worktrees.removeRestoredWorktree({ archive, home, plan: same });
  expect(hasRef(repo, 'refs/heads/' + created.branch)).toBe(true);

  git(repo, 'branch', '-f', created.branch, 'HEAD');
  write(join(repo, 'later.txt'), 'later');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'later');
  git(repo, 'branch', '-f', created.branch, 'HEAD');
  write(join(created.worktree, 'keep.txt'), 'not ours\n');
  const moved = await Worktrees.planRestore({ archive, home, taken: () => new Set(), save: () => {} });
  expect(moved.reuse).toBe(false);
  expect(moved).toMatchObject({ worktree: join(home, '.piop/worktrees', short(chatId, 5)), branch: 'piop/' + short(chatId, 5) });
  const restored = await Worktrees.restoreWorktree({ archive, home, plan: moved });
  expect(git(restored.worktree, 'rev-parse', 'HEAD')).toBe(archive.commit);
  expect(readFileSync(join(created.worktree, 'keep.txt'), 'utf8')).toBe('not ours\n');
  expect(git(repo, 'rev-parse', 'refs/heads/' + created.branch)).toBe(git(repo, 'rev-parse', 'main'));

  await Worktrees.removeRestoredWorktree({ archive, home, plan: moved });
  await Worktrees.removeRestoredWorktree({ archive, home, plan: moved });
  expect(existsSync(moved.worktree)).toBe(false);
  expect(hasRef(repo, 'refs/heads/' + moved.branch)).toBe(false);
  expect(readFileSync(join(created.worktree, 'keep.txt'), 'utf8')).toBe('not ours\n');
  await expect(Worktrees.removeArchivedWorktree({ archive: { ...archive, worktree: created.worktree }, home })).rejects.toThrow(/not a worktree/);
  expect(existsSync(join(created.worktree, 'keep.txt'))).toBe(true);
});

test('a failed archive keeps the worktree, and a moved archive reference is kept', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  git(repo, 'update-ref', 'refs/piop/archives/' + chatId, git(repo, 'rev-parse', 'HEAD'));
  write(join(created.worktree, 'x.txt'), 'x');
  commitAll(created.worktree);
  await expect(Worktrees.protectArchive({ worktree: created, home })).rejects.toThrow(/already points/);
  expect(existsSync(join(created.worktree, 'x.txt'))).toBe(true);
  const fake = { ...created, ref: 'refs/piop/archives/' + chatId, commit: git(created.worktree, 'rev-parse', 'HEAD') };
  await expect(Worktrees.removeArchivedWorktree({ archive: fake, home })).rejects.toThrow(/does not protect/);
  await expect(Worktrees.releaseArchive(fake)).rejects.toThrow(/moved/);
  expect(existsSync(created.worktree)).toBe(true);
  expect(hasRef(repo, fake.ref)).toBe(true);
});

test('deletes a chat permanently and keeps a branch that another worktree uses', async () => {
  const { repo, home, base } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  const archive = await Worktrees.protectArchive({ worktree: created, home });
  await Worktrees.removeArchivedWorktree({ archive, home });
  await Worktrees.deleteChatWorktree({ record: { ...created, archive: { ref: archive.ref, commit: archive.commit } }, home });
  await Worktrees.deleteChatWorktree({ record: { ...created, archive: { ref: archive.ref, commit: archive.commit } }, home });
  expect(hasRef(repo, archive.ref)).toBe(false);
  expect(hasRef(repo, 'refs/heads/' + created.branch)).toBe(false);

  const other = randomUUID();
  const second = await create({ sourceCwd: repo, chatId: other, home });
  await Worktrees.removeCreatedWorktree({ ...second, home });
  git(repo, 'branch', second.branch);
  git(repo, 'worktree', 'add', '--quiet', join(base, 'user'), second.branch);
  await expect(Worktrees.deleteChatWorktree({ record: { ...second, archive: null }, home })).rejects.toThrow(/checked out/);
  expect(hasRef(repo, 'refs/heads/' + second.branch)).toBe(true);
});

test('rejects folders and branches that do not belong to the chat', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  const created = await create({ sourceCwd: repo, chatId, home });
  const archive = await Worktrees.protectArchive({ worktree: created, home });
  await expect(Worktrees.removeArchivedWorktree({ archive: { ...archive, worktree: repo }, home })).rejects.toThrow(/Not a worktree folder/);
  await expect(Worktrees.deleteChatWorktree({ record: { ...created, branch: 'main', archive: null }, home })).rejects.toThrow(/Not a branch/);
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  expect(existsSync(join(repo, 'tracked.txt'))).toBe(true);
});

test('runs concurrent operations on one repository one at a time', async () => {
  const { repo, home } = repository();
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const created = await Promise.all(ids.map(chatId => create({ sourceCwd: repo, chatId, home })));
  created.forEach((worktree, index) => write(join(worktree.worktree, `f${index}.txt`), String(index)));
  write(join(repo, 'main.txt'), 'main');
  for (const cwd of [repo, ...created.map(worktree => worktree.worktree)]) commitAll(cwd);
  const archives = await Promise.all(created.map(worktree => Worktrees.protectArchive({ worktree, home })));
  await Promise.all(archives.map(archive => Worktrees.removeArchivedWorktree({ archive, home })));
  expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/piop/archives').split('\n').length).toBe(6);
  expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length).toBe(1);
});

test('new chats list branches from the main worktree and start clean from the selected branch', async () => {
  const { repo, home, base } = repository();
  git(repo, 'checkout', '-b', 'feature');
  write(join(repo, 'tracked.txt'), 'feature\n');
  git(repo, 'commit', '-am', 'feature');
  const featureCommit = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'main');
  makeDirty(repo);
  const before = status(repo);
  const linked = join(base, 'linked');
  git(repo, 'worktree', 'add', linked, 'feature');
  const choices = await Worktrees.newChatBranches(linked);
  expect(choices).toEqual({ repository: repo, branches: ['feature', 'main'], defaultBranch: 'main' });
  const created = await create({ sourceCwd: repo, home, chatId: randomUUID(), baseBranch: 'feature' });
  expect(created.commit).toBe(featureCommit);
  expect(readFileSync(join(created.worktree, 'tracked.txt'), 'utf8')).toBe('feature\n');
  expect(status(created.worktree)).toBe('');
  expect(status(repo)).toBe(before);
  await Worktrees.removeCreatedWorktree({ ...created, home });
});

test('a missing starting branch leaves no new worktree or branch', async () => {
  const { repo, home } = repository();
  const chatId = randomUUID();
  await expect(create({ sourceCwd: repo, home, chatId, baseBranch: 'missing' })).rejects.toThrow('Branch does not exist');
  expect(readdirSync(Worktrees.worktreesRoot(home))).toEqual([]);
  expect(hasRef(repo, 'refs/heads/piop/' + short(chatId))).toBe(false);
});
