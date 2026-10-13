import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');

if (!process.versions.bun) throw new Error('Run this proof with Bun: the daemon runs the ChatGPT plugin under Bun (bun test/chatgpt-recovery-proof.mjs)');

// Assemble the ChatGPT plugin from the same sources the daemon joins (daemon/src/host/plugins.ts); esbuild resolves its file-lock import.
const joined = 'process.env.PIOP_BUN = ' + JSON.stringify(process.execPath) + ';\nconst emit = event => globalThis.recoveryProofEvents.push(event);\n' +
  source('daemon/resources/chatgpt-stream.mjs') + '\n' + source('daemon/resources/chatgpt-storage.mjs') + '\n' + source('daemon/resources/chatgpt-service.mjs') +
  '\nconst bundledPlugin = { call: handleChatGpt, idle: chatGptIdle, checkpoint: chatGptTicketSnapshot, restore: chatGptRestore };\nexport { bundledPlugin };';
const bundle = await build({ stdin: { contents: joined, resolveDir: fileURLToPath(new URL('daemon/resources/', root)), sourcefile: 'chatgpt-plugin.mjs', loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'node', external: ['bun', 'bun:*'] });
globalThis.recoveryProofEvents = [];
const { bundledPlugin } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const directory = await mkdtemp(join(tmpdir(), 'piop-recovery-proof-'));
const token = ['{"alg":"none"}', JSON.stringify({ sub: 'fixture-user', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }), 'signature']
  .map(part => Buffer.from(part).toString('base64url')).join('.');
const loaded = {
  authPath: join(directory, 'auth.json'),
  runtime: { refresh: async () => {}, getProviderAuthStatus: () => ({ configured: true }), getAuth: async () => ({ auth: { apiKey: token } }) },
};
const client = { providerId: 'openai-codex', clientId: 'proof-client', leaseId: crypto.randomUUID() };
const call = request => bundledPlugin.call(loaded, { ...client, ...request });

let mode = 'success';
let history = { mapping: {}, current_node: null };
let posts = 0;
let stops = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname.replace('/backend-api', '');
  if (path === '/sentinel/chat-requirements/prepare') return Response.json({});
  if (path === '/f/conversation/prepare') return Response.json({});
  if (path === '/stop_conversation') { stops++; return Response.json({}); }
  if (path.startsWith('/conversation/')) {
    if (mode === 'history-offline') throw new TypeError('Simulated history outage');
    return Response.json(history);
  }
  if (path === '/f/conversation') {
    posts++;
    if (mode === 'lost') throw new TypeError('Simulated failure before delivery');
    if (mode === 'rejected') return Response.json({ detail: 'Rejected' }, { status: 403 });
    const message = { id: crypto.randomUUID(), author: { role: 'assistant' }, content: { content_type: 'text', parts: [mode === 'success' ? 'Follow-up succeeded' : 'Answer'] }, status: 'finished_successfully' };
    return new Response('data: ' + JSON.stringify({ conversation_id: 'remote', message }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error('Unexpected network call: ' + options?.method + ' ' + url);
};

const read = chatId => call({ action: 'read', chatId });
async function settled(chatId) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const chat = await read(chatId);
    if (chat.status !== 'streaming') return chat;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Chat ' + chatId + ' did not settle');
}
async function send(chatId, prompt) {
  await call({ action: 'claim', chatId });
  const { ticket } = await call({ action: 'prepare', p: 'proof' });
  await call({ action: 'send', chatId, prompt, model: 'auto', submissionId: crypto.randomUUID(), ticket });
  return settled(chatId);
}
async function started(chatId) {
  mode = 'started';
  assert.equal((await send(chatId, 'Start the conversation')).status, 'complete');
}

try {
  await started('lost');
  mode = 'lost';
  const lost = await send('lost', 'Never delivered');
  assert.equal(lost.status, 'error');
  assert.equal(lost.interrupted, true);
  await assert.rejects(send('lost', 'Blocked'), /Reload this chat/);
  console.log('PASS: undelivered send remains uncertain; a new send is blocked');

  await call({ action: 'claim', chatId: 'lost' });
  const stopped = await call({ action: 'stop', chatId: 'lost' });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.interrupted, undefined);
  assert.equal((await read('lost')).status, 'stopped');
  assert.equal(stops, 1);
  console.log('PASS: stopping recovery invokes the remote stop and persists stopped');

  mode = 'success';
  const postsBefore = posts;
  const followUp = await send('lost', 'Follow-up');
  assert.equal(followUp.status, 'complete');
  assert.equal(posts, postsBefore + 1);
  assert.equal(followUp.messages.at(-1).text, 'Follow-up succeeded');
  console.log('PASS: a subsequent send completes and saves the assistant response');

  await started('accepted');
  mode = 'lost';
  const pending = await send('accepted', 'Accepted but response lost');
  const user = pending.messages.at(-1);
  assert.equal(user.role, 'user');
  history = { current_node: 'recovered', mapping: {
    [user.id]: { parent: null, message: { id: user.id, author: { role: 'user' }, content: { parts: [user.text] } } },
    recovered: { parent: user.id, message: { id: 'recovered', author: { role: 'assistant' }, content: { parts: ['Recovered answer'] }, status: 'finished_successfully' } },
  } };
  const recovered = await read('accepted');
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.parentMessageId, 'recovered');
  assert.equal(recovered.interrupted, undefined); assert.equal(recovered.messages.at(-1).text, 'Recovered answer');
  console.log('PASS: accepted uncertain send automatically recovers assistant response and parent from history');

  history = { mapping: {}, current_node: null };
  await started('offline');
  mode = 'lost'; await send('offline', 'Lost'); mode = 'history-offline';
  assert.equal((await read('offline')).interrupted, true);
  console.log('PASS: history outage returns cached recoverable chat');

  await started('rejected');
  mode = 'rejected';
  const rejected = await send('rejected', 'Rejected');
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.interrupted, false);
  console.log('PASS: definitive HTTP rejection does not enter uncertain recovery');
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
