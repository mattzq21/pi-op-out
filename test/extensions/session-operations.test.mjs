import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import database from '../../daemon/resources/session-database.cjs';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';

const home = await mkdtemp(join(tmpdir(), 'piop-session-operations-home-'));
process.env.HOME = home;
after(() => rm(home, { recursive: true, force: true }));

let compiled;
function compiledControls() {
  return compiled ??= build({
    stdin: { contents: 'export { default as controls } from "./daemon/resources/piop-controls/index.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    external: ['@earendil-works/*'],
    banner: { js: "import { createRequire as __fixtureRequire } from 'node:module'; const require = __fixtureRequire(import.meta.url);" },
    plugins: [storageSchemaImports()],
  });
}

async function fixture(t) {
  const dir = await mkdtemp(join(home, 'storage-'));
  process.env.PIOP_STORAGE_DIRECTORY = basename(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const previousBroker = [process.env.PI_DESKTOP_BROKER_URL, process.env.PI_DESKTOP_BROKER_TOKEN];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method !== 'POST' || request.url !== '/session-identity' || request.headers.authorization !== 'Bearer fixture') {
        response.writeHead(400).end(JSON.stringify({ error: 'Unexpected identity request' }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { action, count } = JSON.parse(Buffer.concat(chunks).toString());
      if (action !== 'reserve' || !Number.isInteger(count) || count < 1 || count > 2) {
        response.writeHead(400).end(JSON.stringify({ error: 'Invalid identity reservation' }));
        return;
      }
      response.end(JSON.stringify({ data: { sessionIds: Array.from({ length: count }, () => database.reserve(dir)) } }));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  process.env.PI_DESKTOP_BROKER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PI_DESKTOP_BROKER_TOKEN = 'fixture';
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const [index, key] of ['PI_DESKTOP_BROKER_URL', 'PI_DESKTOP_BROKER_TOKEN'].entries()) {
      if (previousBroker[index] === undefined) delete process.env[key]; else process.env[key] = previousBroker[index];
    }
  });

  const bundle = await compiledControls();

  await writeFile(join(dir, 'broker.mjs'), bundle.outputFiles[0].contents);
  const module = await import(pathToFileURL(join(dir, 'broker.mjs')));

  const entries = [
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
    { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'fork now' } },
    { type: 'message', id: 'tool', parentId: 'u2', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'pending' }] } },
  ];

  const header = { type: 'session', version: 3, id: database.reserve(dir), cwd: dir };
  const sessions = join(dir, 'sessions');
  await mkdir(sessions);
  const sourcePath = join(sessions, 'source.jsonl');
  const sourceText = [header, ...entries].map(JSON.stringify).join('\n') + '\n';
  await writeFile(sourcePath, sourceText);
  const db = database.open(dir);
  try { database.bind(db, header.id, sourcePath); } finally { db.close(); }
  const notices = [], operations = [], listeners = [];
  const ctx = { cwd: dir, sessionManager: { getEntries: () => entries, getBranch: () => entries, getEntry: id => entries.find(entry => entry.id === id), getHeader: () => header, getSessionId: () => header.id, getSessionFile: () => sourcePath, getSessionDir: () => sessions }, ui: { notify: (...args) => notices.push(args) } };
  module.controls({ on: () => undefined, events: { on: (name, handler) => { if (name === 'piop:rpc') listeners.push(handler); }, emit: (name, request) => { if (name === "hooks-extended") request.hooks = { on: () => () => {} }; } }, appendEntry: (customType, data) => operations.push({ customType, data }) });

  const rpc = async (command, payload) => {
    const request = { command, payload, ctx };

    for (const listener of listeners) listener(request);
    if (!request.ready) throw new Error(`Session command was not registered: ${command}`);
    return request.ready;
  };

  return { ctx, dir, sessions, entries, sourcePath, sourceText, notices, operations, rpc };
}


const readEntries = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);


test('fork retains completed history, unique identity, permissions, and untouched parent', async t => {
  const f = await fixture(t);
  const result = await f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'a1' });
  const entries = await readEntries(result.sessionPath);
  assert.equal(entries[0].parentSession, f.sourcePath);
  assert.deepEqual(entries[0].piopForkSource, { sessionId: f.ctx.sessionManager.getSessionId(), sessionPath: f.sourcePath, entryId: 'a1' });
  assert.notEqual(entries[0].id, f.ctx.sessionManager.getSessionId());
  const db = database.open(f.dir);
  try {
    assert.equal(db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(entries[0].id).session_path, result.sessionPath);
    const hold = db.prepare("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-input-hold'").get(entries[0].id);
    assert.equal(JSON.parse(hold.entry_json).data.held, true);
  } finally { db.close(); }
  assert.equal(entries[0].cwd, f.dir);
  assert.deepEqual(entries.slice(1), [
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
  ]);
  assert.equal((await stat(result.sessionPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('a copy of a branch names the branch as its source, not the branch\'s own source', async t => {
  const f = await fixture(t);
  f.ctx.sessionManager.getHeader().piopForkSource = { sessionId: 'older-chat', sessionPath: '/sessions/older.jsonl', entryId: 'older-entry' };
  const result = await f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'a1' });
  const [header] = await readEntries(result.sessionPath);
  assert.deepEqual(header.piopForkSource, { sessionId: f.ctx.sessionManager.getSessionId(), sessionPath: f.sourcePath, entryId: 'a1' });
  assert.equal(header.parentSession, f.sourcePath);
});

test('fork uses the current project and preserves its files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'project.txt'), 'Unsaved project work');

  const result = await f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'a1' });
  assert.equal(result.cwd, f.dir);
  assert.equal((await readEntries(result.sessionPath))[0].cwd, f.dir);
  assert.equal(await readFile(join(result.cwd, 'project.txt'), 'utf8'), 'Unsaved project work');
});

test('fork rejects a missing response without creating a chat', async t => {
  const f = await fixture(t);
  const before = await readdir(f.sessions);
  await assert.rejects(f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'missing' }), /selected response is no longer on the current branch/);
  assert.deepEqual(await readdir(f.sessions), before);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('fork RPC switches to a completed response without changing the parent', async t => {
  const f = await fixture(t);
  let switched;
  f.ctx.switchSession = async path => { switched = path;

    return { cancelled: false }; };

  assert.deepEqual(await f.rpc('fork_after', { entryId: 'a1' }), { cancelled: false });
  assert.deepEqual((await readEntries(switched)).slice(1), [
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
  ]);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
  const before = await readdir(f.sessions);
  await assert.rejects(f.rpc('fork_after', { entryId: 'tool' }), /unfinished tool calls/);
  assert.deepEqual(await readdir(f.sessions), before);
});



test('forget RPC navigates without recording state and preserves cancelled or invalid requests', async t => {
  const f = await fixture(t);
  const targets = [];
  f.ctx.navigateTree = async id => { targets.push(id);

    return { cancelled: targets.length === 1 }; };

  assert.deepEqual(await f.rpc('fork_and_forget', { entryId: 'a1' }), { cancelled: true });
  assert.deepEqual(f.operations, []);
  assert.deepEqual(await f.rpc('fork_and_forget', { entryId: 'a1' }), { cancelled: false });
  assert.deepEqual(f.operations, []);

  for (const entryId of ['missing', 'u1']) await assert.rejects(f.rpc('fork_and_forget', { entryId }), /Assistant response not found/);
  assert.deepEqual(targets, ['a1', 'a1']);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('fork rejects an unfinished tool call without creating a chat', async t => {
  const f = await fixture(t);
  const before = await readdir(f.sessions);
  await assert.rejects(f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'tool' }), /selected response still has unfinished tool calls/);
  assert.deepEqual(await readdir(f.sessions), before);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('fork after a response rejects a user message without creating a chat', async t => {
  const f = await fixture(t);
  const before = await readdir(f.sessions);
  await assert.rejects(f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'u1' }), /Select an assistant response to branch from/);
  assert.deepEqual(await readdir(f.sessions), before);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('fork rejects an aborted response with unfinished tools without creating a chat', async t => {
  const f = await fixture(t);
  f.entries[3].message.stopReason = 'aborted';
  const before = await readdir(f.sessions);
  await assert.rejects(f.rpc('prepare_fork', { mode: 'fork_after', entryId: 'tool' }), /selected response still has unfinished tool calls/);
  assert.deepEqual(await readdir(f.sessions), before);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

test('fork before the first user message returns an empty history and the draft prompt', async t => {
  const f = await fixture(t);
  f.entries.length = 1;
  const result = await f.rpc('prepare_fork', { mode: 'fork', entryId: 'u1' });
  const history = await readEntries(result.sessionPath);
  assert.equal(history.length, 1);
  assert.equal(history[0].type, 'session');
  assert.equal(result.text, 'first prompt');
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});

for (const customType of ['piop-subagent-parent', 'piop-review-parent']) test(`${customType} cannot fork through session controls`, async t => {
  const f = await fixture(t);
  f.entries.push({ type: 'custom', id: 'parent-marker', customType, data: { parentSessionId: 'parent' } });
  const before = await readdir(f.sessions);
  for (const mode of ['fork', 'fork_after', 'clone']) {
    await assert.rejects(f.rpc('prepare_fork', { mode, entryId: mode === 'fork' ? 'u2' : 'a1' }), /Only main chats can be forked/);
  }
  await assert.rejects(f.rpc('fork_and_forget', { entryId: 'a1' }), /Only main chats can be forked/);
  assert.deepEqual(await readdir(f.sessions), before);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.sourceText);
});
