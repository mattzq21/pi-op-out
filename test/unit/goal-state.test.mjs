import storageExtension from "../../daemon/resources/piop-storage/index.ts";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalState } from '../../daemon/resources/piop-goals/state.ts';
import goals from '../../daemon/resources/piop-storage/goals.cjs';
import database from '../../daemon/resources/session-database.cjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piop-goal-sql-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sessions'));
  const file = join(root, 'sessions', 'chat.jsonl');
  const db = database.open(root);
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('chat-1', file);
  db.close();
  const handlers = new Map();
  const entries = [];
  const pi = { events: { on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); }, emit: (name, request) => handlers.get(name)?.(request) }, appendEntry: (...entry) => entries.push(entry) };
  storageExtension(pi);
  const ctx = { sessionManager: { getSessionId: () => 'chat-1', getSessionFile: () => file }, ui: { setWidget() {}, setStatus() {} } };
  return { root, file, entries, ctx, state: new GoalState(pi), reopen: () => new GoalState(pi) };
}

/** Sets a new active goal, as /goal does. */
function setGoal(f, objective) {
  f.state.goal = { id: crypto.randomUUID(), sessionId: 'chat-1', objective, status: 'active' };
  f.state.save(f.ctx);
}

test('goal changes and clearing survive reload without transcript entries', t => {
  const f = fixture(t);
  setGoal(f, 'Finish the task');
  const id = f.state.goal.id;
  f.state.setStatus(f.ctx, 'paused');
  const restored = f.reopen();
  restored.restore(f.ctx);
  assert.deepEqual(restored.response(), { goal: { id, sessionId: 'chat-1', objective: 'Finish the task', status: 'paused' } });
  restored.clear(f.ctx);
  assert.equal(restored.known(f.ctx, id), true);
  f.state.restore(f.ctx);
  assert.equal(f.state.goal, null);
  assert.deepEqual(f.entries, []);
});

test('forks copy current goal with independent identity and state', t => {
  const f = fixture(t);
  setGoal(f, 'First objective');
  const target = join(f.root, 'sessions', 'fork.jsonl');
  const db = database.open(f.root);
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('chat-2', target);
  db.close();
  goals.copy(f.file, target, 'chat-2');
  const fork = goals.read(target);
  assert.notEqual(fork.id, f.state.goal.id);
  assert.equal(fork.sessionId, 'chat-2');
  assert.equal(fork.objective, 'First objective');
  f.state.clear(f.ctx);
  assert.deepEqual(goals.read(target), fork);
});

test('a failed save restores the last saved in-memory state', t => {
  const f = fixture(t);
  setGoal(f, 'Keep working');
  const db = database.open(f.root);
  db.exec("CREATE TRIGGER reject_goal BEFORE UPDATE ON session_goals BEGIN SELECT RAISE(ABORT, 'Save failed'); END");
  db.close();
  assert.throws(() => f.state.setStatus(f.ctx, 'paused'), /Save failed/);
  assert.equal(f.state.goal.status, 'active');
  assert.equal(goals.read(f.file).status, 'active');
});

test('archive and restore keep goals; deletion removes them', t => {
  const f = fixture(t);
  setGoal(f, 'Keep working');
  const archived = join(f.root, 'archived', 'chat.jsonl');
  const db = database.open(f.root);
  db.prepare('UPDATE sessions SET session_path=? WHERE session_id=?').run(archived, 'chat-1');
  assert.deepEqual(goals.read(archived), f.state.goal);
  db.prepare('UPDATE sessions SET session_path=? WHERE session_id=?').run(f.file, 'chat-1');
  assert.deepEqual(goals.read(f.file), f.state.goal);
  db.prepare('DELETE FROM sessions WHERE session_id=?').run('chat-1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_goals').get().n, 0);
  db.close();
});

test('invalid or mismatched goals are rejected', t => {
  const f = fixture(t);
  assert.throws(() => goals.write(f.file, 'chat-1', { status: 'blocked' }), /Invalid saved goal/);
  setGoal(f, 'Finish');
  assert.throws(() => goals.write(f.file, 'chat-1', { ...f.state.goal, sessionId: 'other' }), /another conversation/);
});

test('storage remains available while other extensions save during shutdown', async () => {
  const { sessionStorage } = await import('../../daemon/resources/piop-storage/interface.ts');
  const handlers = new Map();
  const shutdown = [];
  const entries = [];
  const pi = {
    events: { on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }, emit: (name, request) => handlers.get(name)?.(request) },
    on: (name, handler) => { if (name === 'session_shutdown') shutdown.push(handler); },
    appendEntry: (type, data) => entries.push({ type, data }),
  };
  storageExtension(pi);
  pi.on('session_shutdown', () => sessionStorage(pi).append('final-usage', { tokens: 10 }));
  for (const stop of shutdown) await stop();
  assert.deepEqual(entries, [{ type: 'final-usage', data: { tokens: 10 } }]);
});
