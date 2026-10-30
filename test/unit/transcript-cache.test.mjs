import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { installDom, renderComponent, act } from '../dom.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';
import { createTranscriptCache } from '../../clients/ui/components/transcriptCache.ts';
import { createTranscript } from '../../clients/ui/components/Transcript.tsx';

const state = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', messageCount: 2, pendingMessageCount: 0 };
const turn = (id, text) => [{ id: id + '-prompt', role: 'user', content: 'Question ' + id, timestamp: 1 }, { id: id + '-answer', role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 2 }];

function chat(name) {
  const disposers = new Set();
  return { name, isConnected: () => true, subscribe: () => () => {}, currentHostId: () => 'local', currentCwd: () => '/tmp', ownsConversation: () => true, hasSentMessage: () => true, command: async () => ({}), onDispose(listener) { disposers.add(listener); return () => disposers.delete(listener); }, close() { disposers.forEach(listener => listener()); } };
}

/** A cache whose chats show the messages of their signals while no view shows them, and a view that shows one chat. */
async function setup(t, limits) {
  const dom = installDom();
  const chats = new Map();
  let dispose;
  const cache = createRoot(stop => { dispose = stop; return createTranscriptCache(transport => () => ({ messages: chats.get(transport)[0](), state, actions: {} }), limits); });
  const add = (name, messages) => { const transport = chat(name); chats.set(transport, createSignal(messages)); return transport; };
  const views = [];
  const show = async transport => { const view = await renderComponent(ChatView, { readOnly: true, transcripts: cache, transport, state, get messages() { return chats.get(transport)[0](); }, models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} }); views.push(view); return view; };
  t.after(async () => { for (const view of views) await view.unmount(); dispose(); dom.restore(); });
  return { cache, add, show, answer: (transport, messages) => act(() => chats.get(transport)[1](messages)) };
}

test('a chat that gets a new answer while no view shows it opens with the turns drawn before it opened', async t => {
  const { cache, add, show, answer } = await setup(t);
  const transport = add('a', turn('first', 'First answer'));
  await (await show(transport)).unmount();
  assert.equal(document.querySelectorAll('.markdown-content').length, 0, 'the turns of a chat that no view shows are not on the page');
  await answer(transport, [...turn('first', 'First answer'), ...turn('second', 'New answer')]);
  const hidden = cache.take(transport, createTranscript); cache.release(transport, hidden);
  const answerBody = [...hidden.element.querySelectorAll('.markdown-content')].find(node => node.textContent.includes('New answer'));
  assert.ok(answerBody, 'the new answer is drawn while no view shows the chat');

  const view = await show(transport);
  assert.ok(view.container.contains(answerBody), 'the view shows the answer that was drawn before');
});

test('a chat that no view has shown is drawn when it is prepared, and its view takes those turns', async t => {
  const { cache, add, show } = await setup(t);
  await (await show(add('a', turn('first', 'Answer a')))).unmount();
  const transport = add('b', turn('first', 'Answer b'));
  cache.prepare(transport);
  const prepared = cache.take(transport, createTranscript); cache.release(transport, prepared);
  assert.match(prepared.element.textContent, /Answer b/);
  assert.equal((await show(transport)).container.querySelector('.conversation-turns'), prepared.element);
});

test('closing a chat lets its turns go', async t => {
  const { cache, add, show } = await setup(t);
  const transport = add('a', turn('first', 'Answer a'));
  await (await show(transport)).unmount();
  const before = cache.take(transport, createTranscript); cache.release(transport, before);
  transport.close();
  const after = cache.take(transport, createTranscript); cache.release(transport, after);
  assert.notEqual(after, before);
});

test('the drawn turns of hidden chats go when they need more memory than the limit, but the turns that a view shows stay', async t => {
  const { cache, add, show } = await setup(t, { count: 20, bytes: 1 });
  const hidden = add('a', turn('first', 'Answer a'));
  await (await show(hidden)).unmount();
  const before = cache.take(hidden, createTranscript); cache.release(hidden, before);
  const shown = add('b', turn('first', 'Answer b'));
  const view = await show(shown);
  const drawn = view.container.querySelector('.conversation-turns');
  const after = cache.take(hidden, createTranscript); cache.release(hidden, after);
  assert.notEqual(after, before, 'the hidden chat is drawn again');
  assert.equal(view.container.querySelector('.conversation-turns'), drawn, 'the shown chat keeps its turns');
});

test('the decoded pictures of hidden chats count toward the memory limit once they load', async t => {
  const { cache, add, show } = await setup(t, { count: 20, bytes: 10 * 1024 * 1024 });
  const hidden = add('a', turn('first', 'Answer a'));
  await (await show(hidden)).unmount();
  const before = cache.take(hidden, createTranscript); cache.release(hidden, before);
  const again = cache.take(hidden, createTranscript); cache.release(hidden, again);
  assert.equal(again, before, 'the chat stays drawn while it is in the limit');
  const picture = document.createElement('img');
  Object.defineProperties(picture, { naturalWidth: { value: 4000 }, naturalHeight: { value: 4000 } });
  before.element.querySelector('.markdown-content').append(picture);
  picture.dispatchEvent(new Event('load'));
  const after = cache.take(hidden, createTranscript); cache.release(hidden, after);
  assert.notEqual(after, before, 'a large picture makes the hidden chat go');
});
