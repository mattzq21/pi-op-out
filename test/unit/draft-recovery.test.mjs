import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { act, channelsClosed, installDom, renderComponent, untilDom } from '../dom.mjs';
import { createConversationDrafts } from '../../clients/ui/appDrafts.ts';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { stageDraftSubmission } from '../../clients/ui/lib/draftSubmission.ts';
import { DraftRecovery } from '../../clients/ui/components/DraftRecovery.tsx';

let dom, windows, storageErrors, view;
beforeEach(() => { dom = installDom(); windows = []; storageErrors = []; });
afterEach(async () => {
  await view?.unmount(); view = undefined;
  for (const dispose of windows) dispose();
  try { await channelsClosed('piop-drafts'); } finally { dom.restore(); }
  assert.deepEqual(storageErrors, []);
});

const openWindow = () => createRoot(dispose => { windows.push(dispose); return createConversationDrafts(message => storageErrors.push(message)); });

/** A window that starts sending a message to a chat and is closed before the send ends. */
async function interruptedSend(text, { dispatched = false } = {}) {
  const drafts = openWindow();
  const owner = new NativeTransport({ hostId: 'local', draftKey: 'local:chat-1' });
  drafts.bindTransport(owner, 'local:chat-1');
  drafts.setComposerDraft('local:chat-1', text);
  const handle = await stageDraftSubmission(owner, { rawText: text, uploads: [], consume: true });
  if (dispatched) await handle.dispatch();
  window.dispatchEvent(new Event('pagehide'));
  windows.pop()();
}

/** The next window, with its recovery list shown. */
async function nextWindow() {
  const [conversationKey, setConversationKey] = createSignal("local:chat-1");
  const drafts = openWindow();
  const opened = [];
  view = await renderComponent(DraftRecovery, { drafts, get conversationKey() { return conversationKey(); }, onSelect: session => opened.push(session) });
  await untilDom(() => document.querySelector('[aria-label="Interrupted messages"] summary'));
  const button = text => [...document.querySelectorAll('[aria-label="Interrupted messages"] button')].find(item => item.textContent === text);
  return { drafts, opened, button, setConversationKey, summary: () => document.querySelector('[aria-label="Interrupted messages"] summary').textContent };
}

test('a message whose send was cut off before it reached the host can be restored to its chat', async () => {
  await interruptedSend('Fix the parser');
  const { drafts, opened, button, summary } = await nextWindow();
  assert.equal(summary(), 'Interrupted submission · Fix the parser');
  await act(async () => button('Restore input').click());
  await untilDom(() => !document.querySelector('[aria-label="Interrupted messages"]'));
  for (let tries = 0; !opened.length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(drafts.composerDrafts()['local:chat-1'], 'Fix the parser');
  assert.deepEqual(opened.map(session => [session.id, session.hostId]), [['chat-1', 'local']]);
  assert.deepEqual(drafts.submissions(), []);
});

test('a message that may already have reached the host warns before it is sent again, and can be discarded for good', async () => {
  await interruptedSend('Keep this one');
  await interruptedSend('Deploy to staging', { dispatched: true });
  await nextWindow();
  const deploy = () => [...document.querySelectorAll('[aria-label="Interrupted messages"] details')].find(item => item.querySelector('summary').textContent.includes('Deploy to staging'));
  await untilDom(() => deploy());
  assert.equal(deploy().querySelector('summary').textContent, 'Submission may have been accepted · Deploy to staging');
  assert.match(deploy().textContent, /Check the conversation before restoring and sending again/);
  await act(async () => [...deploy().querySelectorAll('button')].find(item => item.textContent === 'Discard submission').click());
  await untilDom(() => !deploy());
  await view.unmount(); view = undefined;
  window.dispatchEvent(new Event('pagehide'));

  const later = openWindow();
  for (let tries = 0; !later.submissions().length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(later.submissions().map(item => item.rawText), ['Keep this one'], 'a discarded message does not come back in the next window');
});

test('recovery is visible only in its chat and on its machine', async () => {
  await interruptedSend('Only in this chat');
  const { setConversationKey } = await nextWindow();
  for (const key of ['local:chat-2', 'remote:chat-1', undefined, 'local:chat-1']) {
    await act(() => setConversationKey(key));
    assert.equal(Boolean(document.querySelector('[aria-label="Interrupted messages"]')), key === 'local:chat-1');
  }
});
