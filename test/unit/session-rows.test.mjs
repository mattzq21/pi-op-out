import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markRunning, reuseRows } from '../../clients/ui/lib/sessionRows.ts';

const session = (id, extra = {}) => ({ id, hostId: 'local', name: id, path: `/sessions/${id}.jsonl`, project: 'p', cwd: '/p', preview: '', messageCount: 0, lastMessageAt: 0, apiCost: 0, ...extra });

test('a reloaded chat list keeps the rows that did not change, and is the same list when nothing changed', () => {
  const previous = [session('a'), session('b')];
  assert.equal(reuseRows(previous, [session('a'), session('b')]), previous);
  const next = reuseRows(previous, [session('a'), session('b', { name: 'renamed' })]);
  assert.notEqual(next, previous);
  assert.equal(next[0], previous[0]);
  assert.equal(next[1].name, 'renamed');
});

test('a chat that starts working changes only its own row, and a known state changes nothing', () => {
  const rows = [session('a'), session('b'), session('b', { hostId: 'server' })];
  const working = markRunning(rows, 'local', 'b', true);
  assert.deepEqual(working.map(row => Boolean(row.isRunning)), [false, true, false]);
  assert.equal(working[0], rows[0]);
  assert.equal(working[2], rows[2]);
  assert.equal(markRunning(working, 'local', 'b', true), working);
  assert.equal(markRunning(rows, 'local', 'missing', true), rows);
});
