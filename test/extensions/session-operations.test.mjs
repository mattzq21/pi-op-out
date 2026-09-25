import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'piop-session-operations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let source = await readFile(new URL('../../src-tauri/resources/session-broker.ts', import.meta.url), 'utf8');
  source = source.replace(/import \{ Type, type AssistantMessage \} from "@earendil-works\/pi-ai";/, 'const Type = new Proxy({}, { get: () => value => value });')
    .replace(/import \{ getAgentDir \} from "@earendil-works\/pi-coding-agent";/, 'const getAgentDir = () => "unused";')
    .replace('const url = process.env.PI_DESKTOP_BROKER_URL;', 'const url = "http://fixture";')
    .replace('const token = process.env.PI_DESKTOP_BROKER_TOKEN;', 'const token = "fixture";');
  const askSource = (await readFile(new URL('../../src-tauri/resources/ask-user.ts', import.meta.url), 'utf8')).replace('import { Type } from "@earendil-works/pi-ai";', 'const Type = new Proxy({}, { get: () => value => value });');
  await writeFile(join(dir, 'ask-user.mjs'), (await transform(askSource, { loader: 'ts', format: 'esm' })).code);
  source = source.replace('./ask-user.ts', './ask-user.mjs');
  await writeFile(join(dir, 'broker.mjs'), (await transform(source, { loader: 'ts', format: 'esm' })).code);
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
  const notices = [], messages = [], commands = new Map(), tools = new Map();
  const ctx = { cwd: dir, sessionManager: { getBranch: () => entries, getHeader: () => header, getSessionFile: () => sourcePath, getSessionDir: () => dir }, ui: { notify: (...args) => notices.push(args) } };
  module.registerSessionOperations({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), sendMessage: message => messages.push(message) });
  return { ...module, ctx, dir, entries, sourcePath, sourceText, notices, messages, commands, tools };
}

const unexpectedWorktree = async () => { throw Error('Git must not be required'); };
const readEntries = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);

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

test('fork to another directory preserves that directory and does not copy project files', async t => {
  const f = await fixture(t);
  await mkdir(join(f.dir, 'other'));
  const result = await f.forkConversation(f.ctx, { cwd: 'other', entryId: 'a1' }, unexpectedWorktree);
  assert.equal(result.cwd, join(f.dir, 'other'));
  assert.deepEqual(await readdir(result.cwd), []);
  assert.equal((await readEntries(result.sessionPath))[0].cwd, result.cwd);
});

test('invalid fork targets and unfinished history fail before creating a worktree', async t => {
  const f = await fixture(t);
  for (const options of [{ entryId: 'missing' }, { entryId: 'tool' }, { entryId: 'u1' }, { cwd: '.', worktree: 'branch' }, { cwd: 'missing' }]) {
    await assert.rejects(f.forkConversation(f.ctx, options, unexpectedWorktree));
  }
  f.entries[3].message.stopReason = 'aborted';
  await assert.rejects(f.forkConversation(f.ctx, { entryId: 'tool' }, unexpectedWorktree), /completed assistant/);
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

test('tools and slash commands route worktrees to the current host and report results', async t => {
  const f = await fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ data: { path: f.dir, branch: 'fixture' } }) };
  });
  const previous = process.env.PI_DESKTOP_HOST_ID;
  process.env.PI_DESKTOP_HOST_ID = 'remote-fixture';
  t.after(() => { if (previous === undefined) delete process.env.PI_DESKTOP_HOST_ID; else process.env.PI_DESKTOP_HOST_ID = previous; });
  await f.commands.get('create-worktree').handler('experiment', f.ctx);
  await f.tools.get('remove_worktree').execute('call', { cwd: 'other', deleteBranch: true }, undefined, undefined, f.ctx);
  await f.commands.get('fork-session').handler('--worktree experiment', f.ctx);
  assert.deepEqual(requests.map(r => r.url), ['http://fixture/worktrees/create', 'http://fixture/worktrees/remove', 'http://fixture/worktrees/create']);
  assert.ok(requests.every(r => r.body.hostId === 'remote-fixture'));
  assert.equal(requests[1].body.cwd, join(f.dir, 'other'));
  assert.equal(requests[1].body.deleteBranch, true);
  assert.equal(f.messages.length, 2);
  await f.commands.get('remove-worktree').handler('', f.ctx);
  assert.match(f.notices[0][0], /Usage/);
  const fork = await f.tools.get('fork_session').execute('call', {}, undefined, undefined, f.ctx);
  assert.equal(fork.details.hostId, 'remote-fixture');
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

test('cancelled tools do not create sessions or contact the worktree broker', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Cancelled operation contacted broker'); });
  const signal = AbortSignal.abort(new Error('cancelled'));
  const before = await readdir(f.dir);
  for (const [name, params] of [['fork_session', {}], ['create_worktree', { name: 'experiment' }], ['remove_worktree', { cwd: 'other' }]]) {
    await assert.rejects(f.tools.get(name).execute('call', params, signal, undefined, f.ctx), /cancelled/);
  }
  assert.deepEqual(await readdir(f.dir), before);
});
