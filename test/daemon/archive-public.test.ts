import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDaemon, waitForSessions, remoteMachine, useRemotes, type TestDaemon, type RemoteMachine } from './harness';

let daemon: TestDaemon;
let remote: RemoteMachine;
beforeAll(async () => {
  daemon = await startDaemon();
  remote = await remoteMachine(daemon, crypto.randomUUID(), 'Archive server');
  await useRemotes(daemon, [remote]);
  publish('Active chat');
}, 60000);

afterAll(async () => { await remote?.stop(); await daemon?.stop(); }, 60000);

function publish(content: string, folder = "nested ' 日本語"): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: remote.home, folder, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content } }) + '\n' }),
  }));
}
const archive = (sessionId: string) => daemon.invoke('archive_session', { hostId: remote.id, sessionId, terminalIds: [], clientId: 'archive-test' });
const restore = (sessionId: string) => daemon.invoke('restore_session', { hostId: remote.id, sessionId, clientId: 'archive-test' });
const remoteArchives = async () => (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id).archives;

async function historyOf(path: string) {
  const runtimeId = crypto.randomUUID();
  await daemon.invoke('start_pi', { runtimeId, clientId: 'archive-reader', hostId: remote.id, sessionPath: path, cwd: remote.home, presence: { readOnly: true } });
  try { return (await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_entries' } })).entries; }
  finally { await daemon.invoke('stop_pi', { runtimeId }); }
}

test('remote archiving keeps each chat where it is and lists it as archived', async () => {
  const chats = [];
  for (const content of ['First chat', 'Second chat', 'Third chat']) {
    const chat = publish(content);
    chats.push(chat);
    await archive(chat.id);
  }
  const archives = await remoteArchives();
  expect(archives.filter((row: any) => chats.some(chat => chat.id === row.id)).map((row: any) => row.name).sort()).toEqual(['First chat', 'Second chat', 'Third chat']);
  for (const chat of chats) {
    expect(archives.find((row: any) => row.id === chat.id)).toMatchObject({ path: chat.path, cwd: remote.home, restorable: true, deletable: true });
    expect(existsSync(chat.path)).toBe(true);
  }
  const active = await daemon.invoke('list_sessions');
  expect(active.filter((row: any) => chats.some(chat => chat.id === row.id))).toEqual([]);
}, 60000);

test('a remote chat is archived and restored once, and keeps its history', async () => {
  const other = publish('Unrelated active chat');
  const chat = publish('Archive twice');
  await archive(chat.id);
  await expect(archive(chat.id)).rejects.toThrow('This conversation has been deleted or archived');
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === other.id));
  expect(active.filter((row: any) => [other.id, chat.id].includes(row.id))).toMatchObject([{ hostId: remote.id, name: 'Unrelated active chat' }]);
  await restore(chat.id);
  await expect(restore(chat.id)).rejects.toThrow('This conversation is not archived');
  await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  expect((await remoteArchives()).some((row: any) => row.id === chat.id)).toBe(false);
  expect(await historyOf(chat.path)).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Archive twice' } }]);
}, 60000);

test('remote archiving refuses an unknown chat', async () => {
  await expect(archive(crypto.randomUUID())).rejects.toThrow('This conversation has been deleted');
});
