import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

test('listing many chats recovers after a later transcript is corrected', async () => {
  const daemon = await startDaemon();
  try {
    const chats = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat-batch.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, count: 501 }), timeout: 60000,
    })) as Array<{ id: string; path: string; preview: string }>;
    const last = chats.at(-1)!;
    const original = readFileSync(last.path, 'utf8');
    const invalidCost = JSON.stringify({ type: 'message', id: 'cost-one', parentId: null,
      message: { role: 'assistant', content: 'Cost', timestamp: 1000, usage: { cost: { total: 1e308 } } },
    }) + '\n';
    writeFileSync(last.path, original + invalidCost + invalidCost.replace('cost-one', 'cost-two'));
    expect(await daemon.failure('list_sessions')).toContain('gave an invalid result');
    writeFileSync(last.path, original);
    const rows = await daemon.invoke('list_sessions');
    expect(rows).toHaveLength(501);
    for (const chat of chats) {
      expect(rows.find((row: any) => row.path === chat.path)).toMatchObject({ id: chat.id, preview: chat.preview, messageCount: 1 });
    }
  } finally { await daemon.stop(); }
}, 120000);
