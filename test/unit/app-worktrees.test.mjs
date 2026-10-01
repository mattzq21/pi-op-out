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
    createProjectWorktree: async (...args) => { calls.push(['create', ...args]);

    return result; },
    runWorktreeSetup: async (...args) => { calls.push(['setup', ...args]);

    if (options.setupError) throw options.setupError; },
    removeGitWorktree: async (...args) => { calls.push(['remove', ...args]);

    if (options.removeError) throw options.removeError;

    return { warning: options.warning }; },
    currentSessionPath: () => '/sessions/parent.jsonl',
    listSessions: async () => [],
    command: async request => { calls.push(['command', request]);

    return request.type === 'get_entries' ? { entries: options.entries, leafId: options.entries.at(-1)?.id } : request.type === 'get_state' ? { sessionId: 'parent' } : result; },
  };

  const child = {}, memoryDiffs = { a1: { files: [] } };

  const actions = createWorktreeActions({
    settings: () => options.settings, transport: () => owner, runtimePool: () => ({
      captureMemoryDiffs: async transport => { assert.equal(transport, owner);

      return memoryDiffs; },
      forSession: session => { calls.push(['forSession', session]);

      return child; },
      copySavedDiffs: async (...args) => { calls.push(['diffs', ...args]);

      if (options.diffError) throw options.diffError; },
    }),
    addNotice: notice => notices.push(notice), setWorktreeTarget: value => calls.push(['target', value]),
    setSessions: update => sessions.splice(0, sessions.length, ...update(sessions)),
    setComposerDraft: (...args) => calls.push(['draft', ...args]),
    setComposerUploads: (...args) => calls.push(['uploads', ...args]),
    selectSession: session => calls.push(['select', session]),
    syncSessionIndex: () => calls.push(['sync']),
  });

  return { actions, owner, child, memoryDiffs, calls, notices, groups, result, sessions };
}

for (const [hostId, settings, hostName] of [
  ['local', undefined, 'Local'], ['remote', undefined, 'remote'],
  ['missing', { hosts: [] }, 'missing'],
  ['remote', { hosts: [{ id: 'other', name: 'Wrong' }, { id: 'remote', name: 'Server' }] }, 'Server'],
]) test(`project worktrees retain host identity (${hostName}) and run setup before closing`, async t => {
  const f = fixture(t, { settings });
  const onSetup = () => {};

  assert.equal(await f.actions.createWorktree({ transport: f.owner, cwd: '/parent', hostId }, 'experiment', onSetup), f.result);
  assert.deepEqual(f.calls, [['create', '/parent', 'experiment', hostId], ['setup', '/parent', '/child', hostId, onSetup], ['target', undefined]]);
  assert.deepEqual(f.groups, []);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.sessions, [{ id: 'existing' }]);
});

for (const setupError of [new Error('Environment setup cancelled'), new Error('setup failed'), 'script failed']) test(`created project survives setup failure: ${setupError}`, async t => {
  const f = fixture(t, { setupError, groupError: new Error('group failed') });
  assert.equal(await f.actions.createWorktree({ transport: f.owner, cwd: '/parent', hostId: 'local' }, 'experiment'), f.result);
  assert.deepEqual(f.notices, [
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

for (const selected of ['u2', 'a2']) for (const entryId of [true, false]) test(`checkpoint worktree preserves state at ${selected}, entry ID ${entryId}`, async t => {
  const entries = ['u1', 'a1', 'u2', 'a2', 'u3'].map((id, i, ids) => ({ type: 'message', id, parentId: ids[i - 1] ?? null, message: { role: id.startsWith('u') ? 'user' : 'assistant', content: id, timestamp: i + 1 } }));
  const f = fixture(t, { entries });
  const message = { ...entries.find(entry => entry.id === selected).message, ...(entryId ? { entryId: selected } : {}) };
  assert.equal(await f.actions.createWorktree({ transport: f.owner, hostId: 'remote', cwd: '/parent', message }, 'experiment'), f.result);
  assert.deepEqual(f.calls.filter(call => call[0] === 'command'), [['command', { type: 'get_entries' }], ['command', { type: 'get_state' }], ['command', { type: 'branch_checkpoint', entryId: selected, name: 'experiment', afterResponse: selected === 'a2' }]]);
  const session = { id: 'child', path: '/sessions/child.jsonl', cwd: '/child', cwdExists: true, projectKind: 'worktree', projectRoot: '/parent', worktreeRoot: '/child', branch: 'experiment', project: 'parent', name: 'experiment', preview: '', messageCount: 0, lastMessageAt: 0, apiCost: 0, hostId: 'remote' };
  assert.deepEqual(f.sessions, [{ id: 'existing' }, session]);
  assert.deepEqual(f.calls.find(call => call[0] === 'forSession'), ['forSession', session]);
  assert.deepEqual(f.calls.find(call => call[0] === 'draft'), ['draft', 'remote:child', selected === 'u2' ? 'u2' : '']);
  assert.deepEqual(f.calls.find(call => call[0] === 'diffs'), ['diffs', f.child, '/sessions/parent.jsonl', f.result.sessionPath, new Set(selected === 'u2' ? ['u1', 'a1'] : ['u1', 'a1', 'u2', 'a2']), f.memoryDiffs]);
  assert.deepEqual(f.calls.slice(-3), [['uploads', f.child, []], ['select', session], ['sync']]);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.calls.find(call => call[0] === 'target'), ['target', undefined]);
});

test('checkpoint image drafts retain valid images and report diff-copy failures without abandoning the child', async t => {
  const image = { type: 'image', data: 'abcde', mimeType: 'image/png' };
  const entries = [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'prompt', data: 'wrong', mimeType: 'wrong' }, image, { type: 'image', data: '', mimeType: 'image/png' }, { type: 'image', data: 'abc' }] } }];
  const f = fixture(t, { entries, diffError: new Error('cannot copy') });
  await f.actions.createWorktree({ transport: f.owner, hostId: 'local', cwd: '/parent', message: { ...entries[0].message, entryId: 'u1' } }, 'experiment');
  const uploads = f.calls.find(call => call[0] === 'uploads');
  assert.equal(uploads[1], f.child);
  assert.equal(uploads[2].length, 1);
  assert.match(uploads[2][0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(uploads[2][0], { id: uploads[2][0].id, name: 'Attached image', kind: 'image', byteSize: 4, image });
  assert.deepEqual(f.notices, [{ title: 'Worktree created, but project changes could not be copied', message: 'Error: cannot copy' }]);
  assert.deepEqual(f.calls.find(call => call[0] === 'draft'), ['draft', 'local:child', 'prompt']);
  assert.deepEqual(f.calls.at(-1), ['sync']);
});

for (const message of [
  { role: 'user', entryId: 'missing', content: 'prompt', timestamp: 1 },
  { role: 'assistant', entryId: 'u1', content: 'prompt', timestamp: 1 },
  { role: 'user', content: 'different', timestamp: 1 },
  { role: 'user', content: 'prompt', timestamp: 2 },
]) test(`missing checkpoint fails before branching: ${JSON.stringify(message)}`, async t => {
  const entries = [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'prompt', timestamp: 1 } }];
  const f = fixture(t, { entries });
  await assert.rejects(f.actions.createWorktree({ transport: f.owner, hostId: 'local', cwd: '/parent', message }, 'experiment'), { message: 'Could not find the message in the saved conversation' });
  assert.deepEqual(f.calls, [['command', { type: 'get_entries' }]]);
});
