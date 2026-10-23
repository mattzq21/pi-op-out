import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileMessages } from '../../clients/ui/lib/reconcileMessages.ts';

const saved = (id, role, content, extra = {}) => ({ id, entryId: id, role, content, ...extra });
const sent = (id, content, submissionId) => ({ id, role: 'user', content, submissionId });

test('a sent message is replaced by its saved copy in place, and later sent messages stay last', () => {
  const shown = [saved('e1', 'user', 'hi'), saved('e2', 'assistant', 'hello'), sent('local-1', 'fix it', 's1'), sent('local-2', 'and test it', 's2')];
  const history = [saved('e1', 'user', 'hi'), saved('e2', 'assistant', 'hello'), saved('e3', 'user', 'fix it', { piopSubmissionId: 's1' }), saved('e4', 'assistant', 'done')];
  const next = reconcileMessages(shown, history);
  assert.deepEqual(next.map(message => [message.id, message.content]), [['e1', 'hi'], ['e2', 'hello'], ['local-1', 'fix it'], ['e4', 'done'], ['local-2', 'and test it']]);
  assert.equal(next[0], shown[0], 'unchanged messages keep their objects, so their rows are not drawn again');
  assert.equal(next[2].entryId, 'e3');
  assert.equal(next[2].submissionId, undefined);
});

test('a queued message removed from the queue disappears, one still queued stays', () => {
  const shown = [saved('e1', 'user', 'hi'), { ...sent('local-1', 'cancelled', 's1'), piopQueueId: 'q1' }, { ...sent('local-2', 'waiting', 's2'), piopQueueId: 'q2' }];
  const history = [saved('e1', 'user', 'hi')];
  assert.deepEqual(reconcileMessages(shown, history, [{ id: 'q2' }]).map(message => message.id), ['e1', 'local-2']);
  assert.deepEqual(reconcileMessages(shown, history).map(message => message.id), ['e1', 'local-1', 'local-2'], 'without queue news nothing is dropped');
});

test('reloading an unchanged history keeps the same list', () => {
  const shown = [saved('e1', 'user', 'hi'), saved('e2', 'assistant', [{ type: 'text', text: 'hello' }])];
  const history = structuredClone(shown);
  assert.equal(reconcileMessages(shown, history), shown);
  assert.notEqual(reconcileMessages(shown, [...history, saved('e3', 'user', 'more')]), shown);
});

test('two sends of the same text are matched by send, not by text', () => {
  const shown = [sent('local-1', 'retry', 's1'), sent('local-2', 'retry', 's2')];
  const next = reconcileMessages(shown, [saved('e1', 'user', 'retry', { piopSubmissionId: 's2' })]);
  assert.deepEqual(next.map(message => [message.id, message.entryId, message.submissionId]), [['local-2', 'e1', undefined], ['local-1', undefined, 's1']]);
});
