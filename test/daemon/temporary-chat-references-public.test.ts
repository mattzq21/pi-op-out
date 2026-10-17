import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

test('temporary folder cleanup keeps an empty directory used by another saved chat', async () => {
  const daemon = await startDaemon();
  try {
    const temporary = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const saved = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: temporary.cwd, content: JSON.stringify({
        type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Keep this working folder', timestamp: 1 },
      }) + '\n' }),
    }));
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toBe(temporary.cwd);
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.id === saved.id))
      .toMatchObject({ cwd: temporary.cwd, cwdExists: true, preview: 'Keep this working folder' });
  } finally { await daemon.stop(); }
}, 60_000);
