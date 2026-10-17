import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'piop-cache-fork-'));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, 'extension.mjs');
await build({ entryPoints: ['extensions/piop-openai-cache-fork/index.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { default: register } = await import(pathToFileURL(outfile));

async function sessionFile(name, id, parentSession) {
  const path = join(dir, name + '.jsonl');
  await writeFile(path, JSON.stringify({ type: 'session', id, ...(parentSession ? { parentSession } : {}) }) + '\n');
  return path;
}

/** One Pi session running the extension. send() returns the payload the provider would receive. */
function session({ id, file, header, branch = [], model = { provider: 'openai-codex', api: 'openai-codex-responses' } }) {
  const handlers = new Map();
  const entries = [...branch];
  const pi = { on: (name, handler) => handlers.set(name, handler), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const ctx = { model, sessionManager: { getSessionId: () => id, getSessionFile: () => file, getHeader: () => header, getBranch: () => entries } };
  register(pi);
  const send = async payload => (await handlers.get('before_provider_request')({ payload }, ctx)) ?? payload;
  const close = () => handlers.get('session_shutdown')({}, ctx);
  return { send, close, entries };
}

test('a fork of a fork asks OpenAI for the cache of the chat it started from', async () => {
  await sessionFile('root', 'root-id');
  const middle = await sessionFile('middle', 'middle-id', 'root.jsonl');
  const fork = session({ id: 'fork-id', file: join(dir, 'fork.jsonl'), header: { type: 'session', id: 'fork-id', parentSession: middle } });
  try {
    assert.deepEqual(await fork.send({ prompt_cache_key: 'fork-id', input: [] }), { prompt_cache_key: 'root-id', input: [] });
  } finally { fork.close(); }
  const other = session({ id: 'fork-id', file: join(dir, 'fork.jsonl'), header: { type: 'session', id: 'fork-id', parentSession: middle }, model: { provider: 'anthropic', api: 'anthropic-messages' } });
  try {
    assert.deepEqual(await other.send({ prompt_cache_key: 'fork-id' }), { prompt_cache_key: 'fork-id' });
  } finally { other.close(); }
});

test('a reopened fork keeps its cache key after its parent chats are deleted', async () => {
  await sessionFile('first', 'first-id');
  const child = await sessionFile('child', 'child-id', 'first.jsonl');
  const header = { type: 'session', id: 'child-id', parentSession: 'first.jsonl' };
  const opened = session({ id: 'child-id', file: child, header });
  await opened.send({ prompt_cache_key: 'x' });
  opened.close();
  await unlink(join(dir, 'first.jsonl'));
  const reopened = session({ id: 'child-id', file: child, header, branch: opened.entries });
  try {
    assert.deepEqual(await reopened.send({ prompt_cache_key: 'x' }), { prompt_cache_key: 'first-id' });
    assert.equal(reopened.entries.length, 1, 'the key is saved once');
  } finally { reopened.close(); }
});

test('parent chats that point at each other do not stop the request', async () => {
  await sessionFile('loop-a', 'a-id', 'loop-b.jsonl');
  const b = await sessionFile('loop-b', 'b-id', 'loop-a.jsonl');
  const looped = session({ id: 'c-id', file: join(dir, 'loop-c.jsonl'), header: { type: 'session', id: 'c-id', parentSession: b } });
  try {
    assert.match((await looped.send({ prompt_cache_key: 'c-id' })).prompt_cache_key, /^[ab]-id$/);
  } finally { looped.close(); }
});
