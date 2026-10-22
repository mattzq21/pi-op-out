import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { remoteMachine, startDaemon, useRemotes, waitForSessions, type RemoteMachine, type TestDaemon } from './harness';

let daemon: TestDaemon;
let server: RemoteMachine;

beforeAll(async () => {
  daemon = await startDaemon();
  server = await remoteMachine(daemon, 'server', 'Server');
  await useRemotes(daemon, [server]);
}, 60_000);
afterAll(async () => { await server?.stop(); await daemon?.stop(); }, 60_000);

function publicSession(home: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, cwd: home, folder: 'cleanup', content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Group test chat', timestamp: 1 } }) + '\n' }),
  }));
}

const change = (value: any) => daemon.invoke('change_session_groups', { change: value });

test('group cleanup keeps assignments of an unreachable machine and removes deleted local sessions', async () => {
  const remote = publicSession(server.home);
  const local = publicSession(daemon.home);
  await daemon.invoke('load_session_groups', { seeds: [] });
  const group = (await change({ type: 'create', name: 'Kept' })).groups[0].id;
  await change({ type: 'assign', key: 'server:' + remote.id, group });
  await change({ type: 'assign', key: 'local:' + local.id, group });

  await useRemotes(daemon, [{ id: 'server', name: 'Server', target: 'server-unreachable', unreachable: true }]);
  expect(await daemon.invoke('delete_session', { sessionPath: local.path, hostId: 'local', clientId: 'cleanup-test' })).toEqual([local.path]);
  const state = await daemon.invoke('load_session_groups', { seeds: [] });
  expect(state.assignments).toEqual({ ['server:' + remote.id]: group });

  await useRemotes(daemon, [server]);
  const rows = await waitForSessions(daemon, rows => rows.some(row => row.id === remote.id));
  expect(rows.find((row: any) => row.id === remote.id)).toMatchObject({ hostId: 'server', groupId: group });
}, 60_000);
