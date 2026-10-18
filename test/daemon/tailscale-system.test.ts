import { expect, test } from 'bun:test';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { peerCredentials } from '../../daemon/src/tailscale_system';
import { daemonExecutable, temporaryDirectory } from './harness';
import { readFileSync } from 'node:fs';

test('Linux reads the connecting process ID and user from a real socket without root', async () => {
  const path = join(temporaryDirectory(), 'peer.sock');
  const server = createServer({ pauseOnConnect: true });
  let client: Socket | undefined;
  let peer: Socket | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    peer = await new Promise<Socket>((resolve, reject) => {
      server.once('connection', resolve);
      client = connect(path);
      client.once('error', reject);
    });
    expect(await peerCredentials(peer)).toEqual({ pid: process.pid, uid: process.getuid!() });
  } finally {
    client?.destroy();
    peer?.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('normal daemon builds exclude fake Tailscale inputs', async () => {
  const normal = await daemonExecutable();
  const fake = await daemonExecutable({ fakeTailscale: true });
  expect(normal).not.toBe(fake);
  expect(readFileSync(normal, 'utf8')).not.toContain('.fake-peer-credentials');
  expect(readFileSync(fake, 'utf8')).toContain('.fake-peer-credentials');
});
