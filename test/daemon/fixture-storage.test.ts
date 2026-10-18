import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from './harness';

test('stopping retains restart data, disposing releases an owned home', async () => {
  const first = await startDaemon();
  let restarted: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const marker = join(first.home, 'restart-data');
  try {
    writeFileSync(marker, 'keep across restart');
    await first.stop();
    expect(existsSync(marker)).toBe(true);
    restarted = await startDaemon({ home: first.home });
    await restarted.dispose();
    expect(existsSync(marker)).toBe(true);
  } finally {
    await restarted?.stop();
    await first.dispose();
  }
  expect(existsSync(first.home)).toBe(false);
});
