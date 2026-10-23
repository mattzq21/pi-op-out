import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon, type TestDaemon } from './harness';
import { gitRepository } from './agent-chats';
import * as Git from '../../daemon/src/chat_worktrees';
import * as Records from '../../daemon/src/chat_worktree_records';
import * as Lifecycle from '../../daemon/src/chat_worktree_lifecycle';
import { getProjectRepository, rememberProjectRepository } from '../../daemon/src/project_repositories';

/*
 * ADR 0006 archive, restore and deletion of chat worktrees through the real daemon, with real Git. Crash states are made
 * by running single lifecycle steps in this process while the daemon is stopped; the next daemon start must recover them.
 */

const daemons: TestDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); }, 60000);

async function start(home?: string): Promise<TestDaemon> {
  const daemon = await startDaemon(home ? { home } : {});
  daemons.push(daemon);
  return daemon;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch { return null; } };

function publish(home: string, cwd: string, content = 'Worktree chat'): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, cwd, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content } }) + '\n' }),
  }));
}

/** Runs fn with HOME set to home, as the daemon of that home sees it. */
async function asHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = saved; }
}

/** The first n hex digits of the chat ID: the worktree folder and branch name Piop tries first. */
const short = (chatId: string, n = 4) => chatId.replaceAll('-', '').slice(0, n);

interface Scene { daemon: TestDaemon; home: string; profile: string; repo: string; chat: { id: string; path: string }; worktree: string }

/** A daemon with a project repository and one chat that works in a Piop worktree, created the way branching does. */
async function scene(): Promise<Scene> {
  const daemon = await start();
  const home = daemon.home;
  const profile = join(home, '.piop');
  const repo = realpathSync(gitRepository(join(home, 'project')));
  const chat = publish(home, repo);
  const repository = (await Git.detectRepository(repo))!;
  const { worktree } = await Records.create({ sourceCwd: repo, chatId: chat.id, home, repository }, profile);
  rememberProjectRepository(profile, worktree, { root: worktree, gitDir: repository.gitCommonDir });
  Records.activate(chat.id, profile);
  await daemon.invoke('relocate_session', { hostId: 'local', sessionPath: chat.path, cwd: worktree, clientId: 'lifecycle-test' });
  writeFileSync(join(worktree, 'work.txt'), 'saved work');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '--quiet', '-m', 'Piop saving progress');
  return { daemon, home, profile, repo, chat, worktree };
}

const archive = (daemon: TestDaemon, path: string) => daemon.invoke('archive_session', { hostId: 'local', sessionPath: path, terminalIds: [], clientId: 'lifecycle-test' });
const restore = (daemon: TestDaemon, path: string) => daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: path, clientId: 'lifecycle-test' });

async function archivedPath(daemon: TestDaemon, id: string): Promise<string> {
  const report = await daemon.invoke('storage_report');
  const row = report.hosts.find((host: any) => host.hostId === 'local').archives.find((row: any) => row.id === id);
  if (!row) throw new Error('Chat is not archived: ' + id);
  return row.path;
}

async function activeChat(daemon: TestDaemon, id: string): Promise<any> {
  return (await daemon.invoke('list_sessions')).find((row: any) => row.id === id);
}

function transcriptCwd(path: string): string { return JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).cwd; }

test('archiving a chat in the original project folder keeps the folder and its uncommitted files', async () => {
  const daemon = await start();
  const repo = realpathSync(gitRepository(join(daemon.home, 'project')));
  writeFileSync(join(repo, 'dirty.txt'), 'uncommitted');
  const chat = publish(daemon.home, repo);
  await archive(daemon, chat.path);
  expect(readFileSync(join(repo, 'dirty.txt'), 'utf8')).toBe('uncommitted');
  expect(git(repo, 'for-each-ref', 'refs/piop')).toBe('');
  expect(Records.read(chat.id, join(daemon.home, '.piop'))).toBeNull();
  await restore(daemon, await archivedPath(daemon, chat.id));
  expect((await activeChat(daemon, chat.id))?.cwd).toBe(repo);
  expect(readFileSync(join(repo, 'dirty.txt'), 'utf8')).toBe('uncommitted');
}, 120000);

test('archive saves the last commit, removes the worktree and branch, and restore recreates them', async () => {
  const { daemon, profile, repo, chat, worktree } = await scene();
  const saved = git(worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'work.txt'), 'after the last commit');
  await archive(daemon, chat.path);
  expect(existsSync(worktree)).toBe(false);
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/piop/' + short(chat.id))).toBeNull();
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'archived', archive: { commit: saved } });
  const path = await archivedPath(daemon, chat.id);
  await Promise.all([restore(daemon, path), restore(daemon, path)]);
  await restore(daemon, path);
  expect((await activeChat(daemon, chat.id))?.cwd).toBe(worktree);
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');
  expect(git(worktree, 'status', '--porcelain')).toBe('');
  expect(git(worktree, 'branch', '--show-current')).toBe('piop/' + short(chat.id));
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', Records.archiveRef(chat.id))).toBeNull();
  expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ') && line.includes(worktree))).toEqual(['worktree ' + worktree]);
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'active', archive: null, worktree, branch: 'piop/' + short(chat.id) });
}, 120000);

test('restore into an occupied folder and a moved branch uses fresh names and points the chat at the new folder', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  await archive(daemon, chat.path);
  mkdirSync(worktree);
  writeFileSync(join(worktree, 'someone.txt'), 'not Piop');
  git(repo, 'branch', '-f', 'piop/' + short(chat.id), 'HEAD');
  await restore(daemon, await archivedPath(daemon, chat.id));
  const record = Records.read(chat.id, profile)!;
  expect(record.worktree).toBe(join(Git.worktreesRoot(home), short(chat.id, 5)));
  expect(record.branch).toBe('piop/' + short(chat.id, 5));
  const active = await activeChat(daemon, chat.id);
  expect(active.cwd).toBe(record.worktree);
  expect(transcriptCwd(active.path)).toBe(record.worktree);
  expect(readFileSync(join(record.worktree, 'work.txt'), 'utf8')).toBe('saved work');
  expect(readFileSync(join(worktree, 'someone.txt'), 'utf8')).toBe('not Piop');
  expect(getProjectRepository(profile, record.worktree)).toEqual({ root: record.worktree, gitDir: record.gitCommonDir });
  expect(getProjectRepository(profile, worktree)).toBeNull();
}, 120000);

test('a failed restore removes what it created and leaves the chat archived', async () => {
  const { daemon, profile, repo, chat, worktree } = await scene();
  await archive(daemon, chat.path);
  const before = Records.read(chat.id, profile);
  writeFileSync(chat.path, 'Destination is occupied');
  const path = await archivedPath(daemon, chat.id);
  await expect(restore(daemon, path)).rejects.toThrow('Restoration destination already exists');
  expect(existsSync(worktree)).toBe(false);
  expect(Records.read(chat.id, profile)).toEqual(before);
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(before!.archive!.commit);
  expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/piop')).toBe('');
  expect(await archivedPath(daemon, chat.id)).toBe(path);
}, 120000);

test('a failed archive keeps the worktree and the active chat', async () => {
  const { daemon, profile, repo, chat, worktree } = await scene();
  git(repo, 'update-ref', Records.archiveRef(chat.id), git(repo, 'rev-parse', 'HEAD'));
  await expect(archive(daemon, chat.path)).rejects.toThrow('already points to');
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');
  expect(Records.read(chat.id, profile)?.state).toBe('active');
  expect((await activeChat(daemon, chat.id))?.cwd).toBe(worktree);
}, 120000);

test('deleting an archived chat releases its archive reference, branch and record', async () => {
  const { daemon, profile, repo, chat, worktree } = await scene();
  expect(getProjectRepository(profile, worktree)).not.toBeNull();
  await archive(daemon, chat.path);
  const path = await archivedPath(daemon, chat.id);
  await daemon.invoke('delete_archived_session', { hostId: 'local', sessionPath: path, clientId: 'lifecycle-test' });
  expect(git(repo, 'for-each-ref', 'refs/piop', 'refs/heads/piop')).toBe('');
  expect(Records.read(chat.id, profile)).toBeNull();
  expect(getProjectRepository(profile, worktree)).toBeNull();
}, 120000);

test('startup recovery undoes an archive and a restore that stopped before their transcript step', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  await daemon.stop();
  await asHome(home, () => Lifecycle.beginArchive([chat.id], profile));
  expect(Records.read(chat.id, profile)?.state).toBe('archiving');
  const restarted = await start(home);
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'active', archive: null });
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', Records.archiveRef(chat.id))).toBeNull();
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');

  await archive(restarted, chat.path);
  await restarted.stop();
  await asHome(home, () => Lifecycle.beginRestore([chat.id], profile));
  expect(existsSync(worktree)).toBe(true);
  const again = await start(home);
  expect(existsSync(worktree)).toBe(false);
  expect(Records.read(chat.id, profile)?.state).toBe('archived');
  expect(await archivedPath(again, chat.id)).toBeTruthy();
  await restore(again, await archivedPath(again, chat.id));
  expect((await activeChat(again, chat.id))?.cwd).toBe(worktree);
}, 180000);

test('startup recovery finishes an archive whose transcript was archived and undoes a creation whose process died', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  await archive(daemon, chat.path);
  await daemon.stop();
  const archived = Records.read(chat.id, profile)!;
  git(repo, 'worktree', 'add', '--quiet', '--detach', worktree, archived.archive!.commit);
  Records.replace(archived, { ...archived, state: 'archiving' }, profile);

  const orphan = crypto.randomUUID();
  const repository = (await Git.detectRepository(repo))!;
  const orphaned = await Records.create({ sourceCwd: repo, chatId: orphan, home, repository }, profile);
  const db = new DatabaseSync(join(profile, 'sessions.sqlite'));
  try { db.prepare('UPDATE chat_worktrees SET record_json=json_set(record_json, \'$.owner\', \'1:0\') WHERE chat_id=?').run(orphan); }
  finally { db.close(); }

  await start(home);
  expect(existsSync(worktree)).toBe(false);
  expect(Records.read(chat.id, profile)?.state).toBe('archived');
  expect(Records.read(orphan, profile)).toBeNull();
  expect(existsSync(orphaned.worktree)).toBe(false);
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + orphaned.branch)).toBeNull();
}, 180000);

test('a failed worktree removal after archive keeps the archive reference, is reported, and is finished on the next start', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  const saved = git(worktree, 'rev-parse', 'HEAD');
  const locked = Git.worktreesRoot(home);
  chmodSync(locked, 0o555);
  try {
    await archive(daemon, chat.path);
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
    const record = Records.read(chat.id, profile)!;
    expect(record).toMatchObject({ state: 'archived', archive: { commit: saved } });
    expect(record.lastError).toContain('was kept');
    const report = await daemon.invoke('storage_report');
    expect(report.hosts.find((host: any) => host.hostId === 'local').warnings.some((line: string) => line.includes(chat.id) && line.includes('was kept'))).toBe(true);
    expect(await archivedPath(daemon, chat.id)).toBeTruthy();
  } finally { chmodSync(locked, 0o700); }
  await daemon.stop();
  const restarted = await start(home);
  expect(existsSync(worktree)).toBe(false);
  expect(Records.read(chat.id, profile)?.lastError).toBeUndefined();
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
  const report = await restarted.invoke('storage_report');
  expect(report.hosts.find((host: any) => host.hostId === 'local').warnings.some((line: string) => line.includes(chat.id))).toBe(false);
  await restore(restarted, await archivedPath(restarted, chat.id));
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');
}, 180000);

test('a crash after the archive reference was saved but before the record changed is undone, and archiving works again', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  const saved = git(worktree, 'rev-parse', 'HEAD');
  await daemon.stop();
  const active = Records.read(chat.id, profile)!;
  Records.replace(active, { ...active, protecting: true }, profile);
  git(repo, 'update-ref', Records.archiveRef(chat.id), saved);
  const restarted = await start(home);
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', Records.archiveRef(chat.id))).toBeNull();
  expect(Records.read(chat.id, profile)).toEqual(active);
  const report = await restarted.invoke('storage_report');
  expect(report.hosts.find((host: any) => host.hostId === 'local').warnings.some((line: string) => line.includes(chat.id))).toBe(false);
  await archive(restarted, chat.path);
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'archived', archive: { commit: saved } });
  expect(Records.read(chat.id, profile)?.protecting).toBeUndefined();
}, 180000);

test('an archive started after such a crash releases the leftover reference itself', async () => {
  const { daemon, profile, repo, chat, worktree } = await scene();
  const active = Records.read(chat.id, profile)!;
  git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'Piop saving progress');
  const saved = git(worktree, 'rev-parse', 'HEAD');
  Records.replace(active, { ...active, protecting: true }, profile);
  git(repo, 'update-ref', Records.archiveRef(chat.id), git(worktree, 'rev-parse', 'HEAD~1'));
  await archive(daemon, chat.path);
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'archived', archive: { commit: saved } });
}, 120000);

test('archive and deletion retain a shared worktree and its saved state until the last chat is deleted', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  const copy = publish(home, worktree, 'Independent copy');
  const saved = git(worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'work.txt'), 'unsaved shared work');
  await archive(daemon, chat.path);
  expect((await activeChat(daemon, copy.id)).cwd).toBe(worktree);
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('unsaved shared work');
  await daemon.invoke('delete_archived_session', { hostId: 'local', sessionPath: await archivedPath(daemon, chat.id), clientId: 'lifecycle-test' });
  expect(Records.read(chat.id, profile)?.archive?.commit).toBe(saved);
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
  await archive(daemon, copy.path);
  await daemon.stop();
  const restarted = await start(home);
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('unsaved shared work');
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(saved);
  await restore(restarted, await archivedPath(restarted, copy.id));
  const restored = await activeChat(restarted, copy.id);
  expect(restored.cwd).toBe(worktree);
  await restarted.invoke('delete_session', { hostId: 'local', sessionPath: restored.path, clientId: 'lifecycle-test' });
  expect(existsSync(worktree)).toBe(false);
  expect(Records.read(chat.id, profile)).toBeNull();
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', Records.archiveRef(chat.id))).toBeNull();
  expect(tryGit(repo, 'rev-parse', '--verify', '--quiet', 'piop/' + short(chat.id))).toBeNull();
  expect(getProjectRepository(profile, worktree)).toBeNull();
}, 120000);

test('deleting the active owner keeps a worktree used by a chat in a subfolder through restart', async () => {
  const { daemon, home, profile, chat, worktree } = await scene();
  mkdirSync(join(worktree, 'sub'));
  const copy = publish(home, join(worktree, 'sub'));
  await daemon.invoke('delete_session', { hostId: 'local', sessionPath: chat.path, clientId: 'lifecycle-test' });
  await daemon.stop();
  const restarted = await start(home);
  expect(existsSync(worktree)).toBe(true);
  expect(Records.read(chat.id, profile)).not.toBeNull();
  await restarted.invoke('delete_session', { hostId: 'local', sessionPath: copy.path, clientId: 'lifecycle-test' });
  expect(existsSync(worktree)).toBe(false);
  expect(Records.read(chat.id, profile)).toBeNull();
}, 120000);

test('restoring a shared owner reuses its live folder and a failed restore never removes that folder', async () => {
  const { daemon, home, profile, chat, worktree } = await scene();
  const copy = publish(home, worktree);
  await archive(daemon, chat.path);
  writeFileSync(join(worktree, 'work.txt'), 'copy kept working');
  writeFileSync(chat.path, 'occupied');
  await expect(restore(daemon, await archivedPath(daemon, chat.id))).rejects.toThrow('Restoration destination already exists');
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('copy kept working');
  unlinkSync(chat.path);
  await restore(daemon, await archivedPath(daemon, chat.id));
  expect((await activeChat(daemon, chat.id)).cwd).toBe(worktree);
  expect((await activeChat(daemon, copy.id)).cwd).toBe(worktree);
  expect(Records.read(chat.id, profile)?.worktree).toBe(worktree);
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('copy kept working');
}, 120000);

test('deleting the last sharing chat removes an archived owner folder but retains its restore reference', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  const copy = publish(home, worktree);
  await archive(daemon, chat.path);
  expect(existsSync(worktree)).toBe(true);
  await daemon.invoke('delete_session', { hostId: 'local', sessionPath: copy.path, clientId: 'lifecycle-test' });
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, 'rev-parse', Records.archiveRef(chat.id))).toBe(Records.read(chat.id, profile)!.archive!.commit);
  await restore(daemon, await archivedPath(daemon, chat.id));
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');
}, 120000);

test('restart removes archive trash even when the original worktree folder is absent', async () => {
  const { daemon, home, chat, worktree } = await scene();
  await archive(daemon, chat.path);
  await daemon.stop();
  const trash = join(worktree, '..', '.removing-' + short(chat.id) + '-11111111-1111-4111-8111-111111111111');
  mkdirSync(trash);
  writeFileSync(join(trash, 'leftover.txt'), 'Interrupted removal');
  await start(home);
  expect(existsSync(worktree)).toBe(false);
  expect(existsSync(trash)).toBe(false);
}, 120000);

test('archive and restore the transcript when its source repository was removed', async () => {
  const { daemon, profile, repo, chat, worktree } = await scene();
  rmSync(repo, { recursive: true });
  await archive(daemon, chat.path);
  const path = await archivedPath(daemon, chat.id);
  expect(existsSync(chat.path)).toBe(false);
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');
  expect(Records.read(chat.id, profile)).toBeNull();
  await restore(daemon, path);
  expect((await activeChat(daemon, chat.id))?.cwd).toBe(worktree);
}, 120000);

test('recovery rolls back an interrupted archive with a missing repository', async () => {
  const { daemon, home, profile, repo, chat, worktree } = await scene();
  await daemon.stop();
  rmSync(repo, { recursive: true });
  await asHome(home, () => Lifecycle.beginArchive([chat.id], profile));
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'archiving', repositoryMissing: true });
  Lifecycle.stopped([Records.read(chat.id, profile)!]);
  await start(home);
  expect(Records.read(chat.id, profile)).toMatchObject({ state: 'active', archive: null });
  expect(Records.read(chat.id, profile)?.repositoryMissing).toBeUndefined();
  expect(readFileSync(join(worktree, 'work.txt'), 'utf8')).toBe('saved work');
}, 120000);
