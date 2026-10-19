import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalState } from '../../daemon/resources/piop-goals/state.ts';
import records from '../../daemon/resources/piop-goals/goal-records.cjs';

function fixture() {
  const entries = [];
  let branch = entries, sessionId = 'chat-1', fail = false;
  const pi = { appendEntry(customType, data) {
    if (fail) throw new Error('Save failed');
    entries.push({ type: 'custom', customType, data: structuredClone(data), id: String(entries.length + 1), parentId: branch.at(-1)?.id ?? null });
  } };
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => '/chat.jsonl' }, ui: { setWidget() {}, setStatus() {} } };
  return { entries, ctx, state: new GoalState(pi), reopen: () => new GoalState(pi), branch: value => { branch = value; }, session: value => { sessionId = value; }, fail: () => { fail = true; } };
}

test('goal changes and clearing survive reload from the transcript', () => {
  const f = fixture();
  f.state.create(f.ctx, 'Finish the task');
  const id = f.state.goal.id;
  f.state.setStatus(f.ctx, 'paused');
  const restored = f.reopen();
  restored.restore(f.ctx);
  assert.deepEqual(restored.response(), { goal: { id, sessionId: 'chat-1', objective: 'Finish the task', status: 'paused' } });
  restored.clear(f.ctx);
  f.state.restore(f.ctx);
  assert.equal(f.state.goal, null);
  assert.equal(f.entries.at(-1).data, null);
});

test('restore uses the selected branch and gives a copied chat a new goal ID', () => {
  const f = fixture();
  f.state.create(f.ctx, 'First objective');
  const first = f.state.goal.id;
  f.state.clear(f.ctx);
  f.state.create(f.ctx, 'Other objective');
  f.branch(f.entries.slice(0, 1));
  f.state.restore(f.ctx);
  assert.equal(f.state.goal.id, first);
  assert.equal(f.state.goal.objective, 'First objective');
  f.session('chat-2');
  f.state.restore(f.ctx);
  assert.notEqual(f.state.goal.id, first);
  assert.equal(f.state.goal.sessionId, 'chat-2');
});

test('a failed save keeps the last saved goal and reports the failure', () => {
  const f = fixture();
  f.state.create(f.ctx, 'Keep working');
  f.fail();
  assert.throws(() => f.state.setStatus(f.ctx, 'paused'), /Save failed/);
  assert.equal(f.state.goal.status, 'active');
  assert.throws(() => f.state.clear(f.ctx), /Save failed/);
  assert.equal(f.state.goal.status, 'active');
});

test('invalid saved goals are reported', () => {
  const f = fixture();
  f.entries.push({ type: 'custom', customType: 'piop-goal', data: { status: 'blocked' } });
  assert.throws(() => f.state.restore(f.ctx), /Invalid saved goal/);
});

test('closed-chat reads follow transcript parents, including an explicit clear', t => {
  const dir = mkdtempSync(join(tmpdir(), 'piop-goal-records-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'chat.jsonl');
  const goal = { id: 'goal-1', sessionId: 'chat-1', objective: 'Finish', status: 'active' };
  const entries = [
    { type: 'session', id: 'chat-1' },
    { type: 'custom', id: 'a', parentId: null, customType: 'piop-goal', data: goal },
    { type: 'custom', id: 'b', parentId: 'a', customType: 'piop-goal', data: null },
    { type: 'message', id: 'c', parentId: 'a', message: {} },
  ];
  const save = () => writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  save();
  assert.deepEqual(records.read(file), goal);
  entries.push({ type: 'custom', id: 'd', parentId: 'c', customType: 'piop-goal', data: null });
  save();
  assert.equal(records.read(file), null);
});
