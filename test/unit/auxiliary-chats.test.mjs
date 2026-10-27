import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withWorkingSideChats } from '../../clients/ui/lib/auxiliaryChats.ts';

const session = (id, extra = {}) => ({ id, hostId: 'local', name: id, path: `/sessions/${id}.jsonl`, project: 'p', cwd: '/p', preview: '', messageCount: 0, lastMessageAt: 0, apiCost: 0, ...extra });

test('a main chat counts as working in the session list while its btw or review chat answers, also one inside another side chat', () => {
  const sessions = [
    session('main'), session('other'),
    session('btw', { auxiliaryParentId: 'main', auxiliaryKind: 'btw', isRunning: true }),
    session('review', { auxiliaryParentId: 'other', auxiliaryKind: 'review' }),
    session('nested', { auxiliaryParentId: 'review', auxiliaryKind: 'review' }),
  ];
  assert.deepEqual([...withWorkingSideChats(sessions, new Set())].sort(), ['local:main']);
  assert.deepEqual([...withWorkingSideChats(sessions, new Set(['local:nested']))].sort(), ['local:main', 'local:nested', 'local:other']);
});

test('a working subagent does not mark its main chat', () => {
  const sessions = [session('main'), session('helper', { auxiliaryParentId: 'main', auxiliaryKind: 'subagent', isRunning: true })];
  assert.deepEqual([...withWorkingSideChats(sessions, new Set())], []);
});
