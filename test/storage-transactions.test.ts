import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const scenario of ['archive-restore', 'delete', 'rollback', 'busy', 'blank']) {
  test(`storage transactions: ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'piop-storage-test-'));
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/storage-transactions.ts'), scenario], {
        env: { ...process.env, HOME: directory, PIOP_RESTORE_ROOT: undefined },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 20_000);
}
