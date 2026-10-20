import { afterEach, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';
import { gitRepository } from './agent-chats';
import * as History from '../../daemon/src/chat_branch_history';

// Host operation workers do not start under bun test, so storage work runs in this process with the same functions.
mock.module('../../daemon/src/chat_branch_operations', () => ({ publishBranchHistory: History.publishBranchHistory, discardBranchHistory: History.discardBranchHistory }));
const Git = await import('../../daemon/src/chat_worktrees');
const Records = await import('../../daemon/src/chat_worktree_records');
const { getProjectRepository, rememberProjectRepository } = await import('../../daemon/src/project_repositories');
const Registry = await import('../../daemon/src/session_registry');
const { publishBranchHistory } = History;

/*
 * Cleanup of a "Branch from here" that failed before its chat was handed to the user. The steps run in this process the
 * way host/branching.ts runs them, while the daemon is stopped; the next daemon start must finish the cleanup.
 */

const require = createRequire(import.meta.url);
const SessionTables = require('../../daemon/resources/session-database.cjs');
const assets = require('../../daemon/resources/piop-storage/goal-assets.cjs');

const daemons: TestDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); }, 60000);

async function start(home?: string): Promise<TestDaemon> {
  const daemon = await startDaemon(home ? { home } : {});
  daemons.push(daemon);
  return daemon;
}

const branchExists = (repo: string, branch: string) => {
  try { execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { stdio: 'ignore' }); return true; } catch { return false; }
};

function publishSource(home: string, cwd: string): { id: string; path: string } {
  const content = JSON.stringify({ type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop' } }) + '\n';
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, cwd, content }) }));
}

async function asHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = saved; }
}

test('a branch cleanup that fails after activation keeps its recovery record, and the next start removes everything', async () => {
  const daemon = await start();
  const home = daemon.home;
  const profile = join(home, '.piop');
  const repo = realpathSync(gitRepository(join(home, 'project')));
  const source = publishSource(home, repo);
  await daemon.stop();
  daemons.splice(0);

  const entries = readFileSync(source.path, 'utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line));
  const id = Registry.reserve(profile);
  const repository = (await Git.detectRepository(repo))!;
  const worktree = Git.worktreePath(home, id);
  const created = await asHome(home, async () => {
    Records.prepare({ chatId: id, ...repository, worktree }, profile);
    const made = await Git.createWorktree({ sourceCwd: repo, chatId: id, home, repository });
    rememberProjectRepository(profile, made.worktree, { root: made.worktree, gitDir: made.gitCommonDir });
    return made;
  });
  const published = await asHome(home, () => publishBranchHistory({ root: profile, sourcePath: source.path, sessionId: id, cwd: created.worktree, entries, leafId: 'answer', entryId: 'answer' }));
  // The chat was activated, then the hand-off to the user failed.
  Records.activate(id, profile);
  expect(SessionTables.lookup(profile, id)).toBe(published.sessionPath);
  const claims = assets.ownedDirectories(profile, id);

  // A read-only session folder makes the transcript discard fail.
  const folder = dirname(published.sessionPath);
  chmodSync(folder, 0o555);
  let failure: unknown;
  try { await asHome(home, () => Records.abandonCreation(id, published.sessionPath, profile)); }
  catch (error) { failure = error; }
  finally { chmodSync(folder, 0o755); }
  expect(String(failure)).toContain('Could not undo the creation of chat ' + id);

  const kept = Records.read(id, profile)!;
  expect(kept).toMatchObject({ state: 'preparing', owner: Records.RECOVERY_OWNER });
  expect(kept.lastError).toContain('Could not undo the creation of chat ' + id);
  expect(existsSync(published.sessionPath)).toBe(true);
  expect(existsSync(created.worktree)).toBe(true);
  expect(branchExists(repo, created.branch)).toBe(true);

  // The next start runs recovery, which finishes the cleanup.
  const restarted = await start(home);
  expect(Records.read(id, profile)).toBeNull();
  expect(existsSync(published.sessionPath)).toBe(false);
  expect(SessionTables.lookup(profile, id) ?? null).toBeNull();
  expect(assets.ownedDirectories(profile, id)).toEqual([]);
  expect(existsSync(created.worktree)).toBe(false);
  expect(branchExists(repo, created.branch)).toBe(false);
  expect(getProjectRepository(profile, created.worktree)).toBeNull();
  expect((await restarted.invoke('list_sessions')).some((row: any) => row.id === id)).toBe(false);
  const report = await restarted.invoke('storage_report');
  expect(report.hosts.find((host: any) => host.hostId === 'local').warnings.filter((line: string) => line.includes(id))).toEqual([]);
  expect(existsSync(source.path)).toBe(true);
  console.log('claims before cleanup', JSON.stringify(claims));
}, 180000);
