import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { JSDOM } from 'jsdom';

const baseline = process.argv.includes('--baseline');
const root = new URL('../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const backend = await import(`data:text/javascript;base64,${Buffer.from(
  source('crates/daemon/resources/chatgpt-stream.mjs') + '\n' + source('crates/daemon/resources/chatgpt-service.mjs') +
  '\nexport { chatGptSave, chatGptLoad, chatGptSend, chatGptReadChat, chatGptStop, chatGptTickets, chatGptActive, chatGptKey };'
).toString('base64')}`);
const directory = await mkdtemp(join(tmpdir(), 'piop-recovery-proof-'));
const identity = { key: 'fixture', directory, headers: {} };
let mode = 'lost';
let history = { mapping: {}, current_node: null };
let posts = 0;
let stops = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname.replace('/backend-api', '');
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
    const message = { id: 'answer', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Follow-up succeeded'] }, status: 'finished_successfully' };
    return new Response(`data: ${JSON.stringify({ conversation_id: 'remote', message })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error(`Unexpected network call: ${options?.method} ${url}`);
};
function ticket() {
  const id = crypto.randomUUID();
  backend.chatGptTickets.set(id, { account: identity.key, requirements: {}, expires: Date.now() + 60000 });
  return id;
}
async function send(id, prompt) {
  const value = await backend.chatGptSend(identity, { chatId: id, prompt, model: 'auto', submissionId: crypto.randomUUID(), ticket: ticket() });
  await backend.chatGptActive.get(backend.chatGptKey(identity, id))?.done;
  return value;
}
async function seed(id) {
  await backend.chatGptSave(identity, { id, title: id, model: 'auto', conversationId: 'remote', parentMessageId: 'parent', messages: [], status: 'complete', updatedAt: Date.now() });
}
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'screen', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
const owned = value => ({ ...value, ownership: { owned: true, available: false } });
globalThis.recoveryProofInvoke = async (_command, { request }, schema) => {
  let value;
  switch (request.action) {
    case 'accounts': value = [{ id: 'openai-codex', name: 'Fixture', configured: true }]; break;
    case 'models': value = [{ id: 'latest', name: 'Fixture', presets: [{ name: 'Standard', model: 'auto' }] }]; break;
    case 'list': value = [await backend.chatGptLoad(identity, 'lost')]; break;
    case 'claim': case 'release': value = { owned: true, available: false }; break;
    case 'read': value = owned(await backend.chatGptReadChat(identity, request.chatId)); break;
    case 'stop': value = owned(await backend.chatGptStop(identity, request.chatId)); break;
    case 'prepare': value = { ticket: ticket() }; break;
    case 'send': value = owned(await backend.chatGptSend(identity, request)); break;
    default: throw new Error(`Unexpected action ${request.action}`);
  }
  return schema.parse(structuredClone(value));
};
registerHooks({
  load(url, context, next) {
    if (url.endsWith('/clients/ui/lib/platform.ts')) return { format: 'module', shortCircuit: true, source: 'export const invoke = (...args) => globalThis.recoveryProofInvoke(...args);' };
    if (url.endsWith('/clients/ui/components/Markdown.tsx')) return { format: 'module', shortCircuit: true, source: 'export const Markdown = props => props.children;' };
    if (url.endsWith('/challenge.js?raw')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
    if (baseline && /\/src\/plugins\/chatgpt\/(QuickChat.tsx|useChatGpt.ts|chatSchemas.ts)$/.test(url)) {
      const path = new URL(url).pathname.slice(root.pathname.length);
      const old = execFileSync('git', ['show', `2d28b5b4:${path}`], { encoding: 'utf8' });
      return { format: 'module', shortCircuit: true, source: transformSync(old, { filename: path, babelrc: false, configFile: false, presets: [[solid, { generate: 'dom', delegateEvents: false }], typescript] }).code };
    }
    return next(url, context);
  },
});
let dispose;
async function until(check, label) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${label}\nDOM: ${document.body.textContent}`);
}
try {
  await seed('lost');
  await send('lost', 'Never delivered');
  assert.equal((await backend.chatGptLoad(identity, 'lost')).interrupted, true);
  assert.equal((await backend.chatGptReadChat(identity, 'lost')).status, 'error');
  await assert.rejects(send('lost', 'Blocked'), /Reload this chat/);
  console.log('PASS: undelivered send remains uncertain; a new send is blocked');
  const { render } = await import('solid-js/web');
  const { createComponent } = await import('solid-js');
  const { QuickChat } = await import('../clients/ui/plugins/chatgpt/QuickChat.tsx');
  dispose = render(() => createComponent(QuickChat, { open: true, onNew() {} }), document.body);
  await until(() => document.querySelector('option[value="lost"]'), 'history loads');
  const picker = document.querySelector('[aria-label="ChatGPT chat"]');
  picker.value = 'lost'; picker.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => document.querySelector('[aria-label="Stop recovery"]'), 'Expected real QuickChat to render Stop recovery');
  const stop = document.querySelector('[aria-label="Stop recovery"]');
  assert.equal(stop.disabled, false);
  stop.click();
  await until(async () => (await backend.chatGptLoad(identity, 'lost')).status === 'stopped', 'stop persists');
  assert.equal((await backend.chatGptLoad(identity, 'lost')).interrupted, undefined);
  assert.equal(stops, 1);
  console.log('PASS: clicking enabled Stop recovery invokes backend stop and persists stopped');
  mode = 'success';
  await until(() => document.querySelector('[aria-label="Send to ChatGPT"]'), 'composer unblocks');
  const composer = document.querySelector('textarea');
  composer.value = 'Follow-up'; composer.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(async () => (await backend.chatGptLoad(identity, 'lost')).status === 'complete', 'follow-up completes');
  assert.equal(posts, 2);
  assert.equal((await backend.chatGptLoad(identity, 'lost')).messages.at(-1).text, 'Follow-up succeeded');
  console.log('PASS: subsequent send through real composer completes and saves assistant response');
  dispose(); dispose = undefined;
  mode = 'lost'; await seed('accepted'); await send('accepted', 'Accepted but response lost');
  const pending = await backend.chatGptLoad(identity, 'accepted');
  const user = pending.messages.at(-1);
  history = { current_node: 'recovered', mapping: {
    [user.id]: { parent: null, message: { id: user.id, author: { role: 'user' }, content: { parts: [user.text] } } },
    recovered: { parent: user.id, message: { id: 'recovered', author: { role: 'assistant' }, content: { parts: ['Recovered answer'] }, status: 'finished_successfully' } },
  } };
  const recovered = await backend.chatGptReadChat(identity, 'accepted');
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.parentMessageId, 'recovered');
  assert.equal(recovered.interrupted, undefined); assert.equal(recovered.messages.at(-1).text, 'Recovered answer');
  console.log('PASS: accepted uncertain send automatically recovers assistant response and parent from history');
  mode = 'lost'; await seed('offline'); await send('offline', 'Lost'); mode = 'history-offline';
  assert.equal((await backend.chatGptReadChat(identity, 'offline')).interrupted, true);
  console.log('PASS: history outage returns cached recoverable chat');
  mode = 'rejected'; await seed('rejected'); await send('rejected', 'Rejected');
  assert.equal((await backend.chatGptLoad(identity, 'rejected')).interrupted, false);
  console.log('PASS: definitive HTTP rejection does not enter uncertain recovery');
} finally {
  dispose?.(); dom.window.close(); globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
