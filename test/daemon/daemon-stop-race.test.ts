import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { daemonExecutable, temporaryDirectory } from './harness';
import { tryLockFileSync } from '../../daemon/src/util/flock';
import { publish } from '../../daemon/src/settings_records';
import { PROTOCOL_VERSION } from '../../daemon/src/config';

test('stop finishes when a closing daemon releases its lock during connection retries', async () => {
  const executable = await daemonExecutable();
  const home = temporaryDirectory();
  const directory = join(home, '.piop');
  mkdirSync(directory);
  const lock = tryLockFileSync(join(directory, 'daemon.lock'))!;
  let attempts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: {
      message(socket) {
        attempts++;
        socket.close();
        if (attempts === 2) { lock.release(); void server.stop(true); }
      },
    },
  });
  publish(join(directory, 'daemon.json'), JSON.stringify({ url: `ws://127.0.0.1:${server.port}`, token: 'a'.repeat(32), protocol: PROTOCOL_VERSION }));
  const child = Bun.spawn([process.execPath, executable, 'stop'], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Stop kept retrying after the daemon released its lock')), 5000); }),
    ]);
    expect(code).toBe(0);
    expect(attempts).toBe(2);
    expect(await new Response(child.stdout).text()).toContain('Piop daemon is not running.');
  } finally {
    clearTimeout(timer);
    lock.release();
    await server.stop(true);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 15000);
