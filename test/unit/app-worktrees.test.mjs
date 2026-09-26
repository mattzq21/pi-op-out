import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorktreeActions } from '../../src/appWorktrees.ts';

for (const selected of ['u2', 'a2']) test(`checkpoint worktree preserves earlier changes when branching at ${selected}`, async () => {
  const entries = ['u1', 'a1', 'u2', 'a2', 'u3'].map((id, i, ids) => ({ type: 'message', id, parentId: ids[i - 1] ?? null, message: { role: id.startsWith('u') ? 'user' : 'assistant', content: id, timestamp: i + 1 } }));
  const result = { branch: 'child', path: '/child', sessionPath: '/sessions/child.jsonl', sessionId: 'child' };
  const child = {};
  let copied;
  const owner = { currentSessionPath: () => '/sessions/parent.jsonl', command: async request => request.type === 'get_entries' ? { entries, leafId: 'u3' } : result, runWorktreeSetup: async () => {} };
  const actions = createWorktreeActions({ settings: () => undefined, transport: () => owner, runtimePool: () => ({ forSession: () => child, copySavedDiffs: async (...args) => { copied = args; } }), addNotice: () => {}, setWorktreeTarget: () => {}, setSessions: () => {}, setComposerDraft: () => {}, setComposerUploads: () => {}, selectSession: () => {}, syncSessionIndex: () => {} });
  await actions.createWorktree({ transport: owner, hostId: 'local', cwd: '/parent', message: { ...entries.find(entry => entry.id === selected).message, entryId: selected } }, 'child');
  assert.ok(copied, 'copy retained Changes into the new conversation');
  assert.equal(copied[0], child);
  assert.equal(copied[1], '/sessions/parent.jsonl');
  assert.equal(copied[2], result.sessionPath);
  assert.deepEqual([...copied[3]], selected === 'u2' ? ['u1', 'a1'] : ['u1', 'a1', 'u2', 'a2']);
});
