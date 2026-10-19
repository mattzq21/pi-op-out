import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { reserveSessionId, takeSessionId, withSessionIds } from '../../daemon/resources/piop-storage/identities.mjs';

async function daemon(t, reply) {
  const previous = [process.env.PI_DESKTOP_BROKER_URL, process.env.PI_DESKTOP_BROKER_TOKEN];
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer storage-test');
    assert.equal(request.url, '/session-identity');
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: reply(body) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PI_DESKTOP_BROKER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PI_DESKTOP_BROKER_TOKEN = 'storage-test';
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const [i, name] of ['PI_DESKTOP_BROKER_URL', 'PI_DESKTOP_BROKER_TOKEN'].entries()) {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }
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
