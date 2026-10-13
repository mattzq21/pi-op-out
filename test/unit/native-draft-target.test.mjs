import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

test('preparing a remote temporary chat clears the previous conversation target', async t => {
  const dom = installDom();
  t.after(() => dom.restore());
  const client = new NativeTransport({ hostId: 'local', cwd: '/old-project', sessionId: 'old-session', sessionPath: '/old-session.jsonl' });
  await client.prepareTemporaryChat('remote');
  assert.deepEqual(client.connectionTarget(), { hostId: 'remote', cwd: undefined, sessionId: undefined, sessionPath: undefined });
  assert.equal(client.isTemporaryChat(), true);
});

test('a fresh conversation needs defaults until the consumer applies them', t => {
  const dom = installDom();
  t.after(() => dom.restore());
  const client = new NativeTransport({});
  assert.equal(client.needsDefaults(), true);
  client.defaultsApplied();
  assert.equal(client.needsDefaults(), false);
});
