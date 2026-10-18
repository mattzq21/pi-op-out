import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { daemonClient } from '../daemon-client.mjs';

test('UI fixtures release their homes and builds before the next fixture', async () => {
  const initial = (await readdir(tmpdir())).sort();
  for (let run = 0; run < 2; run++) {
    const cleanup = [];
    try {
      const daemon = await daemonClient({ after: callback => cleanup.push(callback) });
      assert.ok(await daemon.invoke('load_app_settings'));
      const files = await readdir(tmpdir(), { recursive: true });
      assert.equal(files.some(path => path.includes('.bun/install/cache')), false);
    } finally {
      for (const close of cleanup) await close();
    }
    assert.deepEqual((await readdir(tmpdir())).sort(), initial);
  }
});
