import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { createConversationDrafts } from '../../src/appDrafts.ts';

test('unsent conversation drafts survive recreating the workspace and stay scoped to their conversation', () => {
  const dom = installDom();

  try {
    const first = createConversationDrafts();
    first.setComposerDraft('local:one', 'Unsent 日本語\nsecond line');
    first.setComposerDraft('remote:one', 'Remote draft');
    const restored = createConversationDrafts();
    assert.equal(restored.composerDrafts()['local:one'], 'Unsent 日本語\nsecond line');
    assert.equal(restored.composerDrafts()['remote:one'], 'Remote draft');
    assert.equal(restored.composerDrafts()['local:two'], undefined);
  } finally { dom.restore(); }
});

test('branching, copying, sending, and discarding cannot resurrect persisted drafts', () => {
  const dom = installDom();

  try {
    const drafts = createConversationDrafts();
    drafts.setComposerDraft('local:parent', 'Keep this draft');
    drafts.rekeyDraft('local:parent', 'local:child', true);
    drafts.rekeyDraft('local:child', 'local:next');
    let restored = createConversationDrafts();
    assert.equal(restored.composerDrafts()['local:parent'], 'Keep this draft');
    assert.equal(restored.composerDrafts()['local:child'], undefined);
    assert.equal(restored.composerDrafts()['local:next'], 'Keep this draft');
    drafts.setComposerDraft('local:next', '');
    drafts.discard({}, 'local:parent');
    restored = createConversationDrafts();
    assert.deepEqual(restored.composerDrafts(), {});
  } finally { dom.restore(); }
});

test('saving one window does not overwrite drafts edited or cleared in another window', () => {
  const dom = installDom();

  try {
    const first = createConversationDrafts();
    const second = createConversationDrafts();
    first.setComposerDraft('local:one', 'First window');
    second.setComposerDraft('local:two', 'Second window');
    assert.deepEqual(createConversationDrafts().composerDrafts(), { 'local:one': 'First window', 'local:two': 'Second window' });
    const stale = createConversationDrafts();
    second.removeDraft('local:two');
    stale.setComposerDraft('local:one', 'Updated first window');
    assert.deepEqual(createConversationDrafts().composerDrafts(), { 'local:one': 'Updated first window' });
  } finally { dom.restore(); }
});
