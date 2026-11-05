import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiStorage } from '../../../daemon/src/host/pi_storage';
import * as StorageLocks from '../../../daemon/resources/storage-locks.ts';

// The daemon answers Pi's storage requests on its main thread, which cannot block. A request that needs the goal asset
// lock while another storage change holds it waits for it, as before the daemon wrote for Pi, and does not fail.
test('a Pi storage request waits for the goal asset lock that another storage change holds', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'piop-goal-lock-')));
  try {
    const held = (await StorageLocks.lock('goal-assets:' + root))!;
    let answered = false;
    const answer = new PiStorage(root).answer(JSON.stringify({ operation: 'publication.releaseHistory', payload: { root, contract: { version: 1, policy: 'shared-profile', directories: [] }, sessionId: 'chat' } }))
      .finally(() => { answered = true; });
    await Bun.sleep(200);
    expect(answered).toBe(false);
    held();
    expect(JSON.parse(await answer)).toEqual({ result: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
