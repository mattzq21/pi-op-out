import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorktreeActions } from '../../src/appWorktrees.ts';

function fixture(t, options = {}) {
  const calls = [], notices = [], groups = [], sessions = [{ id: 'existing' }];
  const result = { branch: 'experiment', path: '/child', sessionPath: '/sessions/child.jsonl', sessionId: 'child' };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (_command, { command, args }) => {
    if (options.groupError) throw options.groupError;
    if (command === 'change_session_groups') groups.push(args.change);
    return { groups: [], assignments: {}, removedProjects: [] };
  } } };
  const owner = {
    createProjectWorktree: async (...args) => { calls.push(['create', ...args]); return result; },
    runWorktreeSetup: async (...args) => { calls.push(['setup', ...args]); if (options.setupError) throw options.setupError; },
    removeGitWorktree: async (...args) => { calls.push(['remove', ...args]); if (options.removeError) throw options.removeError; return { warning: options.warning }; },
  };
  const actions = createWorktreeActions({
    settings: () => options.settings, transport: () => owner, runtimePool: () => ({}),
    addNotice: notice => notices.push(notice), setWorktreeTarget: value => calls.push(['target', value]),
    setSessions: update => sessions.splice(0, sessions.length, ...update(sessions)),
    setComposerDraft: () => assert.fail('Project creation must not create a draft'),
    setComposerUploads: () => assert.fail('Project creation must not attach images'),
    selectSession: () => assert.fail('Project creation must not select a conversation'),
    syncSessionIndex: () => calls.push(['sync']),
  });
  return { actions, owner, calls, notices, groups, result, sessions };
}

for (const [hostId, settings, hostName] of [
  ['local', undefined, 'Local'], ['remote', undefined, 'remote'],
  ['remote', { hosts: [{ id: 'other', name: 'Wrong' }, { id: 'remote', name: 'Server' }] }, 'Server'],
]) test(`project worktrees retain host identity (${hostName}) and run setup before closing`, async t => {
  const f = fixture(t, { settings });
  const onSetup = () => {};
  assert.equal(await f.actions.createWorktree({ transport: f.owner, cwd: '/parent', hostId }, 'experiment', onSetup), f.result);
  assert.deepEqual(f.calls, [['create', '/parent', 'experiment', hostId], ['setup', '/parent', '/child', hostId, onSetup], ['target', undefined]]);
  assert.deepEqual(f.groups, [{ type: 'project', project: { id: `${hostId}:/child`, name: 'experiment', cwd: '/child', hostId, hostName, projectKind: 'worktree' }, key: `${hostId}:child` }]);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.sessions, [{ id: 'existing' }]);
});

for (const setupError of [new Error('Environment setup cancelled'), new Error('setup failed'), 'script failed']) test(`created project survives setup failure: ${setupError}`, async t => {
  const f = fixture(t, { setupError, groupError: new Error('group failed') });
  assert.equal(await f.actions.createWorktree({ transport: f.owner, cwd: '/parent', hostId: 'local' }, 'experiment'), f.result);
  assert.deepEqual(f.notices, [
    { title: 'Worktree created, but could not add its group', message: '/child\nError: group failed' },
    { title: setupError.message === 'Environment setup cancelled' ? 'Environment setup cancelled; worktree kept' : 'Worktree created, but environment setup failed', message: `/child\n${setupError.message ?? setupError}` },
  ]);
  assert.deepEqual(f.calls.at(-1), ['target', undefined]);
});

for (const warning of [undefined, 'Branch retained']) test(`worktree deletion refreshes sessions and reports warning ${warning}`, async t => {
  const f = fixture(t, { warning });
  await f.actions.deleteWorktree('/child', 'remote', false);
  assert.deepEqual(f.calls, [['remove', '/child', 'remote', false], ['sync']]);
  assert.deepEqual(f.notices, warning ? [{ title: 'Worktree deleted with a warning', message: warning }] : []);
});

test('failed worktree deletion propagates the failure without refreshing sessions', async t => {
  const f = fixture(t, { removeError: new Error('busy') });
  await assert.rejects(f.actions.deleteWorktree('/child', 'local', true), /busy/);
  assert.deepEqual(f.calls, [['remove', '/child', 'local', true]]);
});

for (const selected of ['u2', 'a2']) test(`checkpoint worktree preserves earlier changes when branching at ${selected}`, async () => {
  const entries = ['u1', 'a1', 'u2', 'a2', 'u3'].map((id, i, ids) => ({ type: 'message', id, parentId: ids[i - 1] ?? null, message: { role: id.startsWith('u') ? 'user' : 'assistant', content: id, timestamp: i + 1 } }));
  const result = { branch: 'child', path: '/child', sessionPath: '/sessions/child.jsonl', sessionId: 'child' };
  const child = {};
  let copied;
  const owner = { currentSessionPath: () => '/sessions/parent.jsonl', command: async request => request.type === 'get_entries' ? { entries, leafId: 'u3' } : result, runWorktreeSetup: async () => {} };
  const memoryDiffs = { a1: { files: [] } };
  const actions = createWorktreeActions({ settings: () => undefined, transport: () => owner, runtimePool: () => ({ forSession: () => child, captureMemoryDiffs: async transport => { assert.equal(transport, owner); return memoryDiffs; }, copySavedDiffs: async (...args) => { copied = args; } }), addNotice: () => {}, setWorktreeTarget: () => {}, setSessions: () => {}, setComposerDraft: () => {}, setComposerUploads: () => {}, selectSession: () => {}, syncSessionIndex: () => {} });
  await actions.createWorktree({ transport: owner, hostId: 'local', cwd: '/parent', message: { ...entries.find(entry => entry.id === selected).message, entryId: selected } }, 'child');
  assert.ok(copied, 'copy retained Changes into the new conversation');
  assert.equal(copied[0], child);
  assert.equal(copied[1], '/sessions/parent.jsonl');
  assert.equal(copied[2], result.sessionPath);
  assert.equal(copied[4], memoryDiffs);
  assert.deepEqual([...copied[3]], selected === 'u2' ? ['u1', 'a1'] : ['u1', 'a1', 'u2', 'a2']);
});
