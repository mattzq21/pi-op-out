import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test, beforeEach, afterEach } from 'node:test';
import { createEffect, createRoot } from 'solid-js';
import { channelsClosed, installDom } from '../dom.mjs';
import { createConversationDrafts } from '../../clients/ui/appDrafts.ts';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

// A draft saved before each case. Its presence proves a window has finished loading saved drafts.
const SENTINEL = ['local:sentinel', 'Saved earlier'];

let dom, windows, storageErrors;
beforeEach(async () => {
  dom = installDom(); windows = []; storageErrors = [];
  openWindow().setComposerDraft(...SENTINEL);
  leavePage();
  await restoredDrafts({});
});
afterEach(async () => {
  for (const dispose of windows) dispose();

  try { await channelsClosed('piop-drafts'); } finally { dom.restore(); }
  assert.deepEqual(storageErrors, []);
});

function openWindow() {
  return createRoot(dispose => { windows.push(dispose); return createConversationDrafts(message => storageErrors.push(message)); });
}

const leavePage = () => window.dispatchEvent(new Event('pagehide'));

/** Resolves when the drafts shown by `drafts` match `check`, observed on each change. */
function whenDrafts(drafts, check, description, onSettled = () => {}) {
  return new Promise((resolve, reject) => {
    createRoot(stop => {
      let latest;
      const timer = setTimeout(() => { stop(); onSettled(); reject(new assert.AssertionError({ message: `Timed out waiting for ${description}`, actual: latest, expected: description, operator: 'deepStrictEqual' })); }, 2000);
      createEffect(() => {
        latest = { ...drafts.composerDrafts() };

        if (!check(latest)) return;
        clearTimeout(timer);
        queueMicrotask(() => { stop(); onSettled(); });
        resolve();
      });
    });
  });
}

const loaded = drafts => whenDrafts(drafts, value => value[SENTINEL[0]] === SENTINEL[1], 'saved drafts to load');

/** Opens one fresh window and waits until its loaded drafts equal `expected` plus the sentinel. */
function restoredDrafts(expected) {
  const wanted = { ...expected, [SENTINEL[0]]: SENTINEL[1] };
  let dispose;
  const drafts = createRoot(stop => { dispose = stop; return createConversationDrafts(message => storageErrors.push(message)); });

  return whenDrafts(drafts, value => isDeepStrictEqual(value, wanted), JSON.stringify(wanted), () => dispose());
}

test('branching, copying, and discarding cannot resurrect persisted drafts', async () => {
  const drafts = openWindow();
  await loaded(drafts);
  const owner = new NativeTransport({ hostId: 'local', draftKey: 'local:parent' });
  drafts.bindTransport(owner, 'local:parent');
  drafts.setComposerDraft('local:parent', 'Keep this draft');
  drafts.rekeyDraft('local:parent', 'local:child', true);
  drafts.rekeyDraft('local:child', 'local:next');
  leavePage();
  await restoredDrafts({ 'local:parent': 'Keep this draft', 'local:next': 'Keep this draft' });
  drafts.discard(owner);
  leavePage();
  await restoredDrafts({ 'local:next': 'Keep this draft' });
});

test('another window saving a draft preserves an empty composer destination', async () => {
  const first = openWindow();
  const second = openWindow();
  await Promise.all([loaded(first), loaded(second)]);
  first.bindTransport(new NativeTransport({ hostId: 'local', draftKey: 'local:first' }), 'local:first');
  second.bindTransport(new NativeTransport({ hostId: 'local', draftKey: 'local:second' }), 'local:second');
  second.setComposerDraft('local:second', 'Second window draft');
  leavePage();
  await whenDrafts(first, value => value['local:second'] === 'Second window draft', 'the other window draft');

  first.setComposerDraft('local:first', 'First window draft');
  assert.equal(first.records()['local:first'].target?.draftKey, 'local:first');
  assert.equal(first.draftSummaries().find(draft => draft.id === 'first')?.preview, 'First window draft');
  leavePage();
  await restoredDrafts({ 'local:first': 'First window draft', 'local:second': 'Second window draft' });
  const fresh = openWindow();
  await loaded(fresh);
  assert.equal(fresh.records()['local:first'].target?.draftKey, 'local:first');
});
