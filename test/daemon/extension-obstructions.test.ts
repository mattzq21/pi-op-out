import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, temporaryDirectory } from './harness';

test('a file that blocks the extension folder stops Pi starts with its path, stays, and a start after its removal works', async () => {
  const home = temporaryDirectory('piop-home-');
  const obstruction = join(home, '.piop/generated');
  mkdirSync(join(home, '.piop'), { recursive: true, mode: 0o700 });
  writeFileSync(obstruction, 'keep');
  const daemon = await startDaemon({ home });
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const request = { runtimeId: crypto.randomUUID(), clientId: 'extension-obstruction', cwd: daemon.home, sessionPath: chat.path };
    const failure = await daemon.failure('start_pi', request);
    expect(failure).toContain('EEXIST');
    expect(failure).toContain(obstruction);
    expect(readFileSync(obstruction, 'utf8')).toBe('keep');

    rmSync(obstruction);
    expect(await daemon.invoke('start_pi', request)).toMatchObject({ owned: true });
    await daemon.invoke('stop_pi', { runtimeId: request.runtimeId });
  } finally { await daemon.stop(); }
}, 60000);
