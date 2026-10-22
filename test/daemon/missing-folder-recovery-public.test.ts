import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.stop(); });

function publishChat(cwd: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home: daemon.home, content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Saved chat', timestamp: 1 } }) + '\n', cwd }),
  }));
}

const recover = (sessionPath: string) => daemon.invoke('recover_missing_session', { hostId: 'local', sessionPath, action: 'empty', clientId: 'laptop' });
const listed = async (id: string) => (await daemon.invoke('list_sessions')).find((session: any) => session.id === id);

test('a chat whose project folder was deleted moves to a new empty folder, once', async () => {
  const project = join(daemon.home, 'gone-project');
  mkdirSync(project);
  const chat = publishChat(project);
  rmSync(project, { recursive: true });
  expect(await listed(chat.id)).toMatchObject({ cwd: project, cwdExists: false });
  const first = await recover(chat.path);
  expect(first.warnings).toEqual([]);
  expect(first.cwd).not.toBe(project);
  expect(existsSync(first.cwd)).toBe(true);
  expect(readdirSync(first.cwd)).toEqual([]);
  expect(await listed(chat.id)).toMatchObject({ cwd: first.cwd, cwdExists: true });
  expect((await recover(chat.path)).cwd).toBe(first.cwd);
}, 60000);

test('recovery is refused once the project folder exists again, and the chat keeps it', async () => {
  const project = join(daemon.home, 'restored-project');
  mkdirSync(project);
  const chat = publishChat(project);
  expect(await daemon.failure('recover_missing_session', { hostId: 'local', sessionPath: chat.path, action: 'empty', clientId: 'laptop' }))
    .toBe('Could not recover the session directory: The session directory exists again. Refresh the session list before opening it.');
  expect(await listed(chat.id)).toMatchObject({ cwd: project, cwdExists: true });
}, 60000);
