import { expect, test } from 'bun:test';
import { daemonExecutable, temporaryDirectory } from './harness';

test('concurrent daemon starters attach to the winner without waiting for it to stop', async () => {
  const executable = await daemonExecutable();
  const env = { ...process.env, HOME: temporaryDirectory(), PIOP_MOBILE_BIND: '127.0.0.1:0' };
  const starters = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, executable, 'start'], { env, stdout: 'pipe', stderr: 'pipe' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.all(starters.map(child => child.exited)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent daemon start did not finish in 10 seconds')), 10_000); }),
    ]);
    expect(results).toEqual(Array(8).fill(0));
  } finally {
    clearTimeout(timer);
    for (const child of starters) if (child.exitCode === null) child.kill();
    await Promise.all(starters.map(child => child.exited));
    const stop = Bun.spawn([process.execPath, executable, 'stop'], { env, stdout: 'pipe', stderr: 'pipe' });
    await stop.exited;
  }
}, 30_000);
