import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('relocation retains the repository of old prompt checkpoints across multiple moves', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-checkpoint-relocation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = await Promise.all(['one', 'two', 'three'].map(async name => { const root = join(dir, name); await mkdir(root); return root; }));
  const file = join(dir, 'session.jsonl');
  const entry = { type: 'custom', customType: 'pi-project-prompt-checkpoint', data: { key: 'old', owner: 'session', commit: 'a'.repeat(40), base: null } };
  await writeFile(file, [ { type: 'session', id: 'session', cwd: roots[0] }, entry ].map(JSON.stringify).join('\n') + '\n');
  const script = await readFile(new URL('../../src-tauri/resources/relocate-session.cjs', import.meta.url), 'utf8');
  execFileSync(process.execPath, ['-e', script, file, roots[1]]);
  let entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries[1].data.repositoryRoot, roots[0]);
  entries.push({ ...entry, data: { ...entry.data, key: 'new', repositoryRoot: roots[1] } });
  await writeFile(file, entries.map(JSON.stringify).join('\n') + '\n');
  execFileSync(process.execPath, ['-e', script, file, roots[2]]);
  entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries[1].data.repositoryRoot, roots[0]);
  assert.equal(entries[2].data.repositoryRoot, roots[1]);
  assert.equal(entries[0].cwd, roots[2]);
});

test('archive preservation tolerates deleted ancestor refs while preserving child-owned checkpoints', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-archive-checkpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), child = join(dir, 'child'), archive = join(dir, '.piop', 'archived');
  await mkdir(repo); await mkdir(archive, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  git('worktree', 'add', '-b', 'child', child);
  const owned = 'refs/pi-session-snapshots/chats/child/baseline';
  git('update-ref', owned, second);
  const entries = [
    { type: 'session', id: 'child', cwd: child },
    { type: 'message', id: 'old', parentId: null, message: { role: 'assistant' } },
    { type: 'custom', id: 'old-snapshot', parentId: 'old', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: repo, ref: 'refs/pi-session-snapshots/chats/parent/deleted', commit: first, responseEntryIds: ['old'] } },
    { type: 'message', id: 'latest', parentId: 'old-snapshot', message: { role: 'assistant' } },
    { type: 'custom', id: 'baseline', parentId: 'latest', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: child, ref: owned, commit: second, responseEntryIds: ['latest'] } },
  ];
  const file = join(archive, 'child.jsonl');
  await writeFile(file, entries.map(JSON.stringify).join('\n') + '\n');
  const script = await readFile(new URL('../../src-tauri/resources/preserve-archive-checkpoints.cjs', import.meta.url), 'utf8');
  execFileSync(process.execPath, ['-e', script, child], { env: { ...process.env, HOME: dir, PIOP_STORAGE_DIRECTORY: '.piop' }, stdio: 'pipe' });
  const saved = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(saved[0].worktreeRestore.commit, second);
  assert.equal(git('rev-parse', saved[0].worktreeRestore.ref), second);
});

test('temporary conversation cleanup removes its refs without deleting parent checkpoints', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-temporary-checkpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  const commit = git('rev-parse', 'HEAD');
  const ownRef = 'refs/pi-session-snapshots/chats/side/prompts/one', parentRef = 'refs/pi-session-snapshots/chats/parent/prompts/one';
  git('update-ref', ownRef, commit); git('update-ref', parentRef, commit);
  const file = join(dir, 'side.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 'side', cwd: dir }) + '\n');
  const script = await readFile(new URL('../../src-tauri/resources/cleanup-ephemeral-session.cjs', import.meta.url), 'utf8');
  execFileSync(process.execPath, ['-e', script, file]);
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/pi-session-snapshots/'), parentRef);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});
