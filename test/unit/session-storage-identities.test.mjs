import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { reserveSessionId, takeSessionId, withSessionIds } from '../../daemon/resources/piop-storage/identities.mjs';
import { installBroker } from '../runtime-events-fixture.mjs';

function daemon(t, reply) {
  const requests = [];
  installBroker(t, (path, body) => {
    assert.equal(path, '/session-identity');
    requests.push(body);
    return reply(body);
  });
  return requests;
}

test('concurrent session creation uses separate daemon IDs and releases unused reservations', async t => {
  const issued = [];
  const requests = await daemon(t, body => {
    if (body.action === 'release') return null;
    const sessionIds = Array.from({ length: body.count }, randomUUID);
    issued.push(sessionIds);
    return { sessionIds };
  });
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  let entered = 0;
  const create = () => withSessionIds(async () => {
    const id = takeSessionId();
    if (++entered === 2) ready();
    await waiting;
    return id;
  });
  const used = await Promise.all([create(), create()]);
  assert.equal(new Set(used).size, 2);
  assert.deepEqual(used.sort(), issued.map(ids => ids[0]).sort());
  assert.deepEqual(requests.filter(body => body.action === 'release').flatMap(body => body.sessionIds).sort(), issued.map(ids => ids[1]).sort());
  assert.throws(() => takeSessionId(), /not reserved by the daemon/);
});

test('failed session creation releases remaining IDs and reports the original error', async t => {
  const requests = await daemon(t, body => body.action === 'reserve' ? { sessionIds: Array.from({ length: body.count }, randomUUID) } : null);
  await assert.rejects(withSessionIds(() => { throw new Error('Cannot save'); }), /Cannot save/);
  assert.equal(requests.at(-1).action, 'release');
  assert.equal(requests.at(-1).sessionIds.length, 2);
});

test('invalid or repeated daemon IDs are rejected before creating a session', async t => {
  const id = randomUUID();
  await daemon(t, body => ({ sessionIds: Array(body.count).fill(id) }));
  assert.equal(await reserveSessionId(), id);
  await assert.rejects(withSessionIds(() => assert.fail('Must not create a session')), /invalid session identities/);
});
