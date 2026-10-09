import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'piop-session-operations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bundle = await build({
    stdin: { contents: 'export { forkConversation } from "./daemon/resources/session-broker/fork.ts"; export { registerForkAndForget } from "./daemon/resources/session-broker/operations.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'broker-fixture', setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8'))
          .replace(/import \{ Type(?:, type AssistantMessage)? \} from "@earendil-works\/pi-ai";/, 'const Type = new Proxy({}, { get: () => value => value });')
          .replace(/import \{ getAgentDir \} from "@earendil-works\/pi-coding-agent";/, 'const getAgentDir = () => "unused";')
          .replace('const url = process.env.PI_DESKTOP_BROKER_URL;', 'const url = "http://fixture";')
          .replace('const token = process.env.PI_DESKTOP_BROKER_TOKEN;', 'const token = "fixture";'),
        loader: 'ts', resolveDir: join(path, '..'),
      }));
    } }],
  });

  await writeFile(join(dir, 'broker.mjs'), bundle.outputFiles[0].contents);
  const module = await import(pathToFileURL(join(dir, 'broker.mjs')));

  const entries = [
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
    { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'fork now' } },
    { type: 'message', id: 'tool', parentId: 'u2', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'pending' }] } },
  ];

  const header = { type: 'session', version: 3, id: 'source', cwd: dir };
  const sourcePath = join(dir, 'source.jsonl');
  const sourceText = [header, ...entries].map(JSON.stringify).join('\n') + '\n';
  await writeFile(sourcePath, sourceText);
  const notices = [], operations = [], listeners = [];
  const ctx = { cwd: dir, sessionManager: { getEntries: () => entries, getBranch: () => entries, getEntry: id => entries.find(entry => entry.id === id), getHeader: () => header, getSessionFile: () => sourcePath, getSessionDir: () => dir }, ui: { notify: (...args) => notices.push(args) } };
  module.registerForkAndForget({ events: { on: (_name, handler) => listeners.push(handler) }, appendEntry: (customType, data) => operations.push({ customType, data }) });

  const rpc = async (command, payload) => {
    const request = { command, payload, ctx };

    for (const listener of listeners) listener(request);

    return request.ready;
  };

  return { ...module, ctx, dir, entries, sourcePath, sourceText, notices, operations, rpc };
}

const unexpectedWorktree = async () => { throw Error('Git must not be required'); };

const readEntries = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);

test('archived child-owned checkpoints recover missing refs from retained commits', async t => {
  const f = await fixture(t);
  const git = async (...args) => (await exec('git', ['-C', f.dir, ...args])).stdout.trim();
  await git('init');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  const inheritedCommit = await git('rev-parse', 'HEAD');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'child response');
  const commit = await git('rev-parse', 'HEAD');
  const current = 'refs/pi-session-snapshots/chats/child/current';
  await git('update-ref', current, commit);
  const archive = join(f.dir, '.piop', 'archived');
  await mkdir(archive, { recursive: true });
  const file = join(archive, 'child.jsonl');
  await writeFile(file, [
    { type: 'session', id: 'child', cwd: f.dir },
    { type: 'custom', id: 'old', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: f.dir, ref: 'refs/pi-session-snapshots/chats/child/deleted', commit: inheritedCommit } },
    { type: 'message', id: 'response', parentId: 'old', message: { role: 'assistant' } },
    { type: 'custom', id: 'last', parentId: 'response', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: f.dir, ref: current, commit, responseEntryIds: ['response'] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const script = await readFile(new URL('../../daemon/resources/preserve-archive-checkpoints.bundle.mjs', import.meta.url), 'utf8');
  await exec(process.execPath, ['-e', `require('node:os').homedir = () => ${JSON.stringify(f.dir)};\n${script}`, f.dir], { env: { ...process.env, PIOP_STORAGE_DIRECTORY: '.piop' } });
  const entries = await readEntries(file);
  assert.match(entries[1].data.ref, /^refs\/pi-session-snapshots\/chats\/child\//);
  assert.equal(await git('rev-parse', entries[1].data.ref), inheritedCommit);
});

test('non-Git fork retains completed history, unique identity, permissions, and untouched parent', async t => {
  const f = await fixture(t);
  const result = await f.forkConversation(f.ctx, {}, unexpectedWorktree);
  const entries = await readEntries(result.sessionPath);
  assert.equal(entries[0].parentSession, f.sourcePath);
  assert.notEqual(entries[0].id, 'source');
  assert.equal(entries[0].cwd, f.dir);
  assert.deepEqual(entries.slice(1), f.entries.slice(0, 2));
  assert.equal((await stat(result.sessionPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('fork to another directory creates it without copying project files', async t => {
  const f = await fixture(t);
  const result = await f.forkConversation(f.ctx, { cwd: 'other', entryId: 'a1' }, unexpectedWorktree);
  assert.equal(result.cwd, join(f.dir, 'other'));
  assert.deepEqual(await readdir(result.cwd), []);
  assert.equal((await readEntries(result.sessionPath))[0].cwd, result.cwd);
});

test('invalid fork targets and unfinished history fail before creating a worktree', async t => {
  const f = await fixture(t);

  for (const options of [{ entryId: 'missing' }, { entryId: 'tool' }, { entryId: 'u1' }, { cwd: '.', worktree: 'branch' }, { cwd: 'missing/child' }, { cwd: '.' }]) {
    await assert.rejects(f.forkConversation(f.ctx, options, unexpectedWorktree));
  }

  f.entries[3].message.stopReason = 'aborted';
  await assert.rejects(f.forkConversation(f.ctx, { entryId: 'tool' }, unexpectedWorktree), /unfinished tool calls/);
  f.entries.length = 1;
  assert.equal((await readEntries((await f.forkConversation(f.ctx, {}, unexpectedWorktree)).sessionPath)).length, 1);
});

test('worktree fork returns setup failures with the created path and session', async t => {
  const f = await fixture(t);

  const result = await f.forkConversation(f.ctx, { worktree: 'experiment' }, async name => {
    assert.equal(name, 'experiment');

    return { path: join(f.dir, 'new-tree'), branch: 'project-experiment', setupError: 'setup failed' };
  });

  assert.equal(result.setupError, 'setup failed');
  assert.equal((await readEntries(result.sessionPath))[0].cwd, result.path);
});

test('fork RPC switches to a completed response without changing the parent', async t => {
  const f = await fixture(t);
  let switched;
  f.ctx.switchSession = async path => { switched = path;

    return { cancelled: false }; };

  assert.deepEqual(await f.rpc('fork_after', { entryId: 'a1' }), { cancelled: false });
  assert.deepEqual((await readEntries(switched)).slice(1), f.entries.slice(0, 2));
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
  const before = await readdir(f.dir);
  await assert.rejects(f.rpc('fork_after', { entryId: 'tool' }), /unfinished tool calls/);
  assert.deepEqual(await readdir(f.dir), before);
});

test('Git sessions fork in place and into an independent real worktree', async t => {
  const f = await fixture(t);
  const git = (...args) => exec('git', ['-C', f.dir, ...args]);
  await git('init');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  const sourceHead = (await git('rev-parse', 'HEAD')).stdout;
  const same = await f.forkConversation(f.ctx, {}, unexpectedWorktree);
  assert.equal(same.cwd, f.dir);
  const destination = join(f.dir, 'worktree');

  const fork = await f.forkConversation(f.ctx, { worktree: 'experiment' }, async branch => {
    await git('worktree', 'add', '-b', branch, destination);

    return { path: destination, branch };
  });

  assert.equal((await exec('git', ['-C', fork.cwd, 'branch', '--show-current'])).stdout.trim(), 'experiment');
  assert.equal((await git('rev-parse', 'HEAD')).stdout, sourceHead);
  assert.deepEqual((await readEntries(fork.sessionPath)).slice(1), f.entries.slice(0, 2));
});

test('an unopened fork owns inherited prompt checkpoints before its parent is deleted', async t => {
  const f = await fixture(t);
  const git = (...args) => exec('git', ['-C', f.dir, ...args]);
  await git('init');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  const sourceRef = 'refs/pi-session-snapshots/chats/source/prompts/before';
  await git('update-ref', sourceRef, commit);
  f.entries.splice(1, 0, { type: 'custom', id: 'checkpoint', parentId: 'u1', customType: 'pi-project-prompt-checkpoint', data: { key: 'before', owner: 'source', commit, base: commit } });
  const child = await f.forkConversation(f.ctx, {}, unexpectedWorktree);
  await git('update-ref', '-d', sourceRef, commit);
  assert.equal((await git('rev-parse', '--verify', `refs/pi-session-snapshots/chats/${child.sessionId}/prompts/before`)).stdout.trim(), commit);
});

test('forget RPC records successful navigation and preserves cancelled or invalid requests', async t => {
  const f = await fixture(t);
  const targets = [];
  f.ctx.navigateTree = async id => { targets.push(id);

    return { cancelled: targets.length === 1 }; };

  assert.deepEqual(await f.rpc('fork_and_forget', { entryId: 'a1' }), { cancelled: true });
  assert.deepEqual(f.operations, []);
  assert.deepEqual(await f.rpc('fork_and_forget', { entryId: 'a1' }), { cancelled: false });
  assert.deepEqual(f.operations, [{ customType: 'pi-desktop-fork-and-forget', data: { entryId: 'a1' } }]);

  for (const entryId of ['missing', 'u1']) await assert.rejects(f.rpc('fork_and_forget', { entryId }), /Assistant response not found/);
  assert.deepEqual(targets, ['a1', 'a1']);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});
