import storageExtension from "../../daemon/resources/piop-storage/index.ts";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as goals from '../../daemon/resources/piop-storage/goals.ts';
import { connection } from '../../daemon/resources/session-database/core.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piop-goal-sql-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sessions'));
  const file = join(root, 'sessions', 'chat.jsonl');
  const db = connection(root);
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('chat-1', file);
  return { root, file };
}

function setGoal(f, objective) {
  const goal = { id: crypto.randomUUID(), sessionId: 'chat-1', objective, status: 'active' };
  goals.write(f.file, 'chat-1', goal);
  return goal;
}

test('goal changes and clearing are saved without transcript entries, and an opened chat reads them', t => {
  const f = fixture(t);
  const goal = setGoal(f, 'Finish the task');
  goals.write(f.file, 'chat-1', { ...goal, objective: 'Finish the edited task' });
  assert.deepEqual(goals.restore(f.file), { goal: { ...goal, objective: 'Finish the edited task' }, waitingForInput: false });
  goals.write(f.file, 'chat-1', null);
  assert.deepEqual(goals.restore(f.file), { goal: null, waitingForInput: false });
  assert.deepEqual(goals.restore(join(f.root, 'sessions', 'unregistered.jsonl')), { goal: null, waitingForInput: false });
});

test('an opened branch reads that its goal waits for the user\'s first message', t => {
  const f = fixture(t);
  setGoal(f, 'Keep the branch going');
  const db = connection(f.root);
  db.prepare("INSERT INTO session_extension_state VALUES ('chat-1', 'piop-input-hold', ?)").run(JSON.stringify({ type: 'custom', customType: 'piop-input-hold', data: { held: true } }));
  assert.equal(goals.restore(f.file).waitingForInput, true);
});

test('forks copy current goal with independent identity and state', t => {
  const f = fixture(t);
  const goal = setGoal(f, 'First objective');
  const target = join(f.root, 'sessions', 'fork.jsonl');
  const db = connection(f.root);
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('chat-2', target);
  goals.copy(f.file, target, 'chat-2');
  const fork = goals.read(target);
  assert.notEqual(fork.id, goal.id);
  assert.equal(fork.sessionId, 'chat-2');
  assert.equal(fork.objective, 'First objective');
  goals.write(f.file, 'chat-1', null);
  assert.deepEqual(goals.read(target), fork);
});

test('archive and restore keep goals; deletion removes them', t => {
  const f = fixture(t);
  const goal = setGoal(f, 'Keep working');
  const archived = join(f.root, 'archived', 'chat.jsonl');
  const db = connection(f.root);
  db.prepare('UPDATE sessions SET session_path=? WHERE session_id=?').run(archived, 'chat-1');
  assert.deepEqual(goals.read(archived), goal);
  db.prepare('UPDATE sessions SET session_path=? WHERE session_id=?').run(f.file, 'chat-1');
  assert.deepEqual(goals.read(f.file), goal);
  db.prepare('DELETE FROM sessions WHERE session_id=?').run('chat-1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_goals').get().n, 0);
});

test('invalid or mismatched goals are rejected', t => {
  const f = fixture(t);
  assert.throws(() => goals.write(f.file, 'chat-1', { status: 'blocked' }), /Invalid saved goal/);
  const goal = setGoal(f, 'Finish');
  assert.throws(() => goals.write(f.file, 'chat-1', { ...goal, sessionId: 'other' }), /another conversation/);
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
