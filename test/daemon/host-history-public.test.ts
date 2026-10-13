import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

test('large non-ASCII history fits the client wire limit and reports omitted entries', async () => {
  const daemon = await startDaemon();
  try {
    const session = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home: daemon.home, content: '' }),
    }));
    const content = '界'.repeat(1024 * 1024);
    for (let index = 0; index < 48; index++) {
      appendFileSync(session.path, JSON.stringify({
        id: String(index), parentId: index ? String(index - 1) : null, type: 'message',
        message: { role: 'assistant', content },
      }) + '\n');
    }
    const runtimeId = crypto.randomUUID();
    await daemon.invoke('start_pi', { runtimeId, clientId: 'history-reader', sessionPath: session.path, cwd: daemon.home, presence: { readOnly: true } });
    const history = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_entries' } });
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(128 * 1024 * 1024);
    expect(history.omittedEntries).toBeGreaterThan(0);
    expect(history.omittedEntries + history.entries.length).toBe(48);
    expect(history.entries.at(-1)).toMatchObject({ id: '47', message: { content } });
    expect(history.leafId).toBe('47');
    await daemon.invoke('stop_pi', { runtimeId });
  } finally { await daemon.stop(); }
}, 60000);
