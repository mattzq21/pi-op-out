import { expect, test } from 'bun:test';

const { DaemonClients } = await import('../../daemon/src/daemon_clients');

const app = { restart: { gate: { tryWrite: () => () => {} } } } as any;
const stops = (clients: InstanceType<typeof DaemonClients>) => clients.waitForShutdown(app, async () => {}).then(() => Date.now());

test('a daemon with an unused delay stops once it has had no client for that long', async () => {
  const started = Date.now();
  const clients = new DaemonClients(() => {}, () => {}, 200);
  clients.persist();
  const stopped = await stops(clients);
  expect(stopped - started).toBeGreaterThanOrEqual(190);
  expect(clients.closing()).toBe(true);
});

test('a connected client keeps the daemon running, and the delay counts again from its disconnect', async () => {
  const clients = new DaemonClients(() => {}, () => {}, 200);
  const client = clients.connect();
  let stoppedAt = 0;
  void stops(clients).then(at => { stoppedAt = at; });
  await Bun.sleep(400);
  expect(stoppedAt).toBe(0);
  const left = Date.now();
  client.release();
  for (let tries = 0; !stoppedAt && tries < 50; tries++) await Bun.sleep(20);
  expect(stoppedAt - left).toBeGreaterThanOrEqual(190);
});
