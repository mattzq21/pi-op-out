import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { act, channelsClosed, installDom, renderComponent, untilDom } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { createConversationDrafts } from '../../clients/ui/appDrafts.ts';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { stageDraftSubmission } from '../../clients/ui/lib/draftSubmission.ts';
import { DraftRecovery } from '../../clients/ui/components/DraftRecovery.tsx';

let dom, windows, storageErrors, view;
beforeEach(() => { dom = installDom(); windows = []; storageErrors = []; });
afterEach(async () => {
  await view?.unmount(); view = undefined;
  for (const dispose of windows) dispose();
  clearMocks();
  try { await channelsClosed('piop-drafts'); } finally { dom.restore(); }
  assert.deepEqual(storageErrors, []);
});

const openWindow = () => createRoot(dispose => { windows.push(dispose); return createConversationDrafts(message => storageErrors.push(message)); });

async function interruptedSend(text, { dispatched = false } = {}) {
  const drafts = openWindow();
  const owner = new NativeTransport({ hostId: 'local', draftKey: 'local:chat-1' });
  drafts.bindTransport(owner, 'local:chat-1');
  drafts.setComposerDraft('local:chat-1', text);
  const handle = await stageDraftSubmission(owner, { rawText: text, uploads: [], consume: true });
  if (dispatched) await handle.dispatch();
  window.dispatchEvent(new Event('pagehide'));
  windows.pop()();
  return handle.id;
}

async function nextWindow(onSelected = () => {}) {
  const [conversationKey, setConversationKey] = createSignal("local:chat-1");
  const drafts = openWindow();
  const opened = [];
  view = await renderComponent(DraftRecovery, { drafts, get conversationKey() { return conversationKey(); }, onSelect: session => { opened.push(session); onSelected(session); } });
  await untilDom(() => document.querySelector('[aria-label="Interrupted messages"] summary'));
  const button = text => [...document.querySelectorAll('[aria-label="Interrupted messages"] button')].find(item => item.textContent === text);
  return { drafts, opened, button, setConversationKey, summary: () => document.querySelector('[aria-label="Interrupted messages"] summary').textContent };
}

test('a message whose send was cut off before it reached the host can be restored to its chat', { timeout: 5000 }, async () => {
  await interruptedSend('Fix the parser');
  const selected = Promise.withResolvers();
  const { drafts, opened, button, summary } = await nextWindow(selected.resolve);
  assert.equal(summary(), 'Interrupted submission · Fix the parser');
  await act(async () => button('Restore input').click());
  await untilDom(() => !document.querySelector('[aria-label="Interrupted messages"]'));
  await selected.promise;
  assert.equal(drafts.composerDrafts()['local:chat-1'], 'Fix the parser');
  assert.deepEqual(opened.map(session => [session.id, session.hostId]), [['chat-1', 'local']]);
  assert.deepEqual(drafts.submissions(), []);
});

test('a message sent before its window closed is gone when the host accepted it, and restorable when the host did not', async () => {
  const ids = {};
  const asked = [];
  mockIPC((command, args) => {
    assert.deepEqual([command, args.hostId], ['submission_outcome', 'local']);
    asked.push(args.submissionId);
    return args.submissionId === ids.accepted ? { accepted: true } : { accepted: false, error: 'Piop did not receive this message' };
  });
  ids.accepted = await interruptedSend('Deploy to staging', { dispatched: true });
  ids.refused = await interruptedSend('Fix the parser', { dispatched: true });
  const { drafts, summary } = await nextWindow();
  await untilDom(() => drafts.submissions().length === 1 && summary() === 'Interrupted submission · Fix the parser');
  assert.ok(asked.includes(ids.accepted) && asked.includes(ids.refused));
  assert.equal(drafts.submissions()[0].error, 'Piop did not receive this message');
});

test('recovery is visible only in its chat and on its machine', async () => {
  await interruptedSend('Only in this chat');
  const { setConversationKey } = await nextWindow();
  for (const key of ['local:chat-2', 'remote:chat-1', undefined, 'local:chat-1']) {
    await act(() => setConversationKey(key));
    assert.equal(Boolean(document.querySelector('[aria-label="Interrupted messages"]')), key === 'local:chat-1');
  }
});
