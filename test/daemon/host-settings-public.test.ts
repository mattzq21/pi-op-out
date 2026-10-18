import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, temporaryDirectory, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop());

/** Saves a real conversation file and returns its id and path. */
const publishChat = (): { id: string; path: string } => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
  encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home: daemon.home, cwd: daemon.home, folder: 'ids', content: '' }),
}));

test('the session ids another machine reads list saved and archived chats, but not deleted ones', async () => {
  const [kept, archived, deleted] = [publishChat(), publishChat(), publishChat()];
  await daemon.invoke('archive_session', { sessionPath: archived.path, hostId: 'local', terminalIds: [], clientId: 'ids-test' });
  await daemon.invoke('delete_session', { sessionPath: deleted.path, hostId: 'local', clientId: 'ids-test' });
  const ids = await daemon.invoke('session_ids', {});
  expect(ids).toContain(kept.id);
  expect(ids).toContain(archived.id);
  expect(ids).not.toContain(deleted.id);
});

test('settings saved from another machine change this host, but keep its own shortcuts and debug mode', async () => {
  const before = await daemon.invoke('load_host_settings', { hostId: 'local' });
  const edited = structuredClone(before);
  edited.contextWindowCap = 200_000;
  edited.debugMode = !before.debugMode;
  edited.keybindings.newConversation = 'Ctrl+F7';
  await daemon.invoke('save_host_settings', { hostId: 'local', settings: edited, agentsChanged: false });
  const after = await daemon.invoke('load_host_settings', { hostId: 'local' });
  expect(after.contextWindowCap).toBe(200_000);
  expect(after.debugMode).toBe(before.debugMode);
  expect(after.keybindings).toEqual(before.keybindings);
});

test('the daemon is not idle for a restart while a terminal runs, and is idle again once it closes', async () => {
  // A new daemon does storage work at start; wait for that to end.
  for (const deadline = Date.now() + 10_000; await daemon.failure('check_daemon_idle', {}).catch(() => null) && Date.now() < deadline;) await Bun.sleep(100);
  expect(await daemon.invoke('check_daemon_idle', {})).toBeNull();
  await daemon.invoke('start_terminal', { terminalId: 'busy-terminal', sessionKey: 'local:idle-check', cwd: temporaryDirectory('piop-idle-'), cols: 80, rows: 24 });
  expect(await daemon.failure('check_daemon_idle', {})).toContain('Close running terminals');
  await daemon.invoke('close_terminal', { terminalId: 'busy-terminal' });
  expect(await daemon.invoke('check_daemon_idle', {})).toBeNull();
});
