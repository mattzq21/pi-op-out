import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon, type TestDaemon } from './harness';
import { gitRepository } from './agent-chats';
import * as Git from '../../daemon/src/worktrees/worktrees';
import * as Records from '../../daemon/src/worktrees/records';
import * as History from '../../daemon/src/host_operations/branch_history';
import { getProjectRepository, rememberProjectRepository } from '../../daemon/src/projects/repositories';

const database = require('../../daemon/resources/session-database.ts');
const core = require('../../daemon/resources/session-database/core.ts');
const newChats = require('../../daemon/resources/piop-storage/new-chats.ts');
const goals = require('../../daemon/resources/piop-storage/goals.ts');

const daemons: TestDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); }, 60000);

async function start(home?: string): Promise<TestDaemon> {
  const daemon = await startDaemon(home ? { home } : {});
  daemons.push(daemon);
  return daemon;
}

async function stop(daemon: TestDaemon): Promise<void> {
  await daemon.stop();
  daemons.splice(daemons.indexOf(daemon), 1);
}

async function inStorage<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PIOP_STORAGE_DIRECTORY;
  process.env.PIOP_STORAGE_DIRECTORY = relative(realpathSync(homedir()), profile);
  try { return await fn(); }
  finally { if (saved === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = saved; }
}

const branchExists = (repo: string, branch: string) => {
  try { execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { stdio: 'ignore' }); return true; } catch { return false; }
};
const objective = (profile: string, id: string): string | undefined => core.connection(profile).prepare('SELECT objective FROM session_goals WHERE session_id=?').get(id)?.objective;
const warnings = async (daemon: TestDaemon, id: string): Promise<string[]> =>
  (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === 'local').warnings.filter((line: string) => line.includes(id));

async function sourceChat(profile: string, repo: string) {
  const folder = join(profile, 'sessions', 'project');
  mkdirSync(folder, { recursive: true });
  const id = database.reserve(profile);
  const path = join(folder, '2026-10-20T00-00-00-000Z_' + id + '.jsonl');
  const message = (entryId: string, parentId: string | null, role: string, text: string, extra: any = {}) =>
    ({ type: 'message', id: entryId, parentId, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }], timestamp: 1, ...extra } });
  const entries = [message('u1', null, 'user', 'Ship it'), message('a1', 'u1', 'assistant', 'Answer', { stopReason: 'stop' })];
  const header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: repo };
  newChats.create(profile, { path, entries: [header, ...entries] });
  goals.write(path, id, { id: randomUUID(), sessionId: id, objective: 'Ship it', status: 'active' });
  return { id, path, entries };
}

async function unfinishedBranch() {
  const first = await start();
  const home = first.home;
  const profile = join(home, '.piop');
  const repo = realpathSync(gitRepository(join(home, 'project')));
  await stop(first);
  const parts = await inStorage(profile, async () => {
    const source = await sourceChat(profile, repo);
    const id = database.reserve(profile);
    const repository = (await Git.detectRepository(repo))!;
    const created = await Records.create({ sourceCwd: repo, chatId: id, home, repository }, profile);
    rememberProjectRepository(profile, created.worktree, { root: created.worktree, gitDir: created.gitCommonDir });
    const published = await History.publishBranchHistory({ root: profile, sourcePath: source.path, sessionId: id, cwd: created.worktree, entries: source.entries, leafId: 'a1', entryId: 'a1' });
    return { source, id, created, published };
  });
  return { home, profile, repo, ...parts };
}

async function expectRemoved(daemon: TestDaemon, branch: Awaited<ReturnType<typeof unfinishedBranch>>, sourceBody: string) {
  const { profile, repo, source, id, created, published } = branch;
  expect(Records.read(id, profile)).toBeNull();
  expect(existsSync(published.sessionPath)).toBe(false);
  expect(database.lookup(profile, id) ?? null).toBeNull();
  expect(objective(profile, source.id)).toBe('Ship it');
  expect(existsSync(created.worktree)).toBe(false);
  expect(branchExists(repo, created.branch)).toBe(false);
  expect(getProjectRepository(profile, created.worktree)).toBeNull();
  expect(await warnings(daemon, id)).toEqual([]);
  expect((await daemon.invoke('list_sessions')).some((row: any) => row.id === id)).toBe(false);
  expect(readFileSync(source.path, 'utf8')).toBe(sourceBody);
}

test('recovery keeps an unfinished branch creation whose cleanup failed, reports it, and later removes all its parts', async () => {
  const branch = await unfinishedBranch();
  const { home, profile, repo, source, id, created, published } = branch;
  const db = new DatabaseSync(join(profile, 'sessions.sqlite'));
  try { db.prepare("UPDATE chat_worktrees SET record_json=json_set(record_json, '$.owner', '1:0') WHERE chat_id=?").run(id); }
  finally { db.close(); }
  expect(objective(profile, id)).toBe('Ship it');
  expect(existsSync(published.sessionPath)).toBe(true);
  const sourceBody = readFileSync(source.path, 'utf8');

  const folder = dirname(published.sessionPath);
  chmodSync(folder, 0o555);
  let failing: TestDaemon;
  try {
    failing = await start(home);
    const kept = Records.read(id, profile)!;
    expect(kept).toMatchObject({ state: 'preparing', owner: Records.RECOVERY_OWNER });
    expect(kept.lastError).toContain('Could not undo the creation of chat ' + id);
    expect((await warnings(failing, id)).some(line => line.includes('Could not undo the creation'))).toBe(true);
    expect(existsSync(published.sessionPath)).toBe(true);
    expect(existsSync(created.worktree)).toBe(true);
    expect(branchExists(repo, created.branch)).toBe(true);
  } finally { chmodSync(folder, 0o755); }
  await stop(failing!);

  await expectRemoved(await start(home), branch, sourceBody);
}, 180000);

test('a failed cleanup of an activated branch that was never handed to the user leaves it for recovery', async () => {
  const branch = await unfinishedBranch();
  const { home, profile, repo, source, id, created, published } = branch;
  const sourceBody = readFileSync(source.path, 'utf8');
  Records.activate(id, profile);
  const failure = await Records.abandonCreation(id, published.sessionPath, profile).then(() => null, error => String(error?.message ?? error));
  expect(failure).toContain('Could not undo the creation of chat ' + id);
  const kept = Records.read(id, profile)!;
  expect(kept).toMatchObject({ state: 'preparing', owner: Records.RECOVERY_OWNER });
  expect(kept.lastError).toContain('Could not undo the creation of chat ' + id);
  expect(existsSync(published.sessionPath)).toBe(true);
  expect(existsSync(created.worktree)).toBe(true);
  expect(branchExists(repo, created.branch)).toBe(true);

  await expectRemoved(await start(home), branch, sourceBody);
}, 180000);
