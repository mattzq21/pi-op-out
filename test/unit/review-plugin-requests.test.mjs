import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewRequest } from '../../clients/ui/plugins/review/requests.tsx';

function fixture(patch = {}, options = {}) {
  const sent = [];
  const payload = { sessionId: 'review', sessionPath: '/review.jsonl', parentSessionId: 'parent', cwd: '/repo', task: 'Check changes', ...patch };
  const result = parseReviewRequest({ id: 'request', placeholder: JSON.stringify(payload) }, {
    activeHostId: 'remote', pendingImages: [{ type: 'image', mimeType: 'image/png', data: 'image' }],
    parent: { connectionTarget: () => ({ sessionId: 'parent' }), command: async command => { sent.push(command); } }, ...options,
  });
  return { ...result, sent };
}

test('review opening keeps the host, attachments and feedback target', async () => {
  const result = fixture();
  assert.equal(result.session.hostId, 'remote');
  assert.equal(result.session.id, 'review');
  assert.equal(result.request.initialPrompt, 'Check changes');
  assert.equal(result.request.initialImages[0].data, 'image');
  assert.equal(typeof result.request.actions, 'function');
});

test('archived or inherited read-only reviews cannot submit a new task or feedback', () => {
  for (const reason of ['archived', 'inherited']) {
    const result = fixture({ readOnly: true, [reason]: true, hostId: 'saved-host' });
    assert.equal(result.session.hostId, 'saved-host');
    assert.equal(result.request.readOnly, true);
    assert.equal(result.request.initialPrompt, undefined);
    assert.equal(result.request.initialImages, undefined);
    assert.equal(result.request.actions, undefined);
  }
});

test('invalid review requests fail before opening a side conversation', () => {
  assert.throws(() => fixture({ parentSessionId: undefined }), /Invalid \/review request/);
  assert.throws(() => fixture({ sessionPath: undefined }), /Missing saved review session/);
});
