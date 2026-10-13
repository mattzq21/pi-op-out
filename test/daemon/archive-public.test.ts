import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, remoteMachine, useRemotes, type TestDaemon, type RemoteMachine } from './harness';

let daemon: TestDaemon;
let remote: RemoteMachine;
beforeEach(async () => {
  daemon = await startDaemon();
  remote = await remoteMachine(daemon, crypto.randomUUID(), 'Archive server');
  await useRemotes(daemon, [remote]);
  publish('Active chat');
}, 60000);
afterEach(async () => { await remote?.stop(); await daemon?.stop(); }, 60000);

function publish(content: string, folder = "nested ' 日本語"): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: remote.home, folder, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content } }) + '\n' }),
  }));
}
const archive = (path: string) => daemon.invoke('archive_session', { hostId: remote.id, sessionPath: path, terminalIds: [], clientId: 'archive-test' });

test('remote archiving preserves each chat and earlier archives', async () => {
  const chats = [];
  for (const content of ['First chat', 'Second chat', 'Third chat']) {
    const chat = publish(content);
    chats.push(chat);
    await archive(chat.path);
  }
  const report = await daemon.invoke('storage_report');
  const host = report.hosts.find((host: any) => host.hostId === remote!.id);
  expect(host.error).toBeUndefined();
  expect(host.archives.map((archive: any) => archive.name).sort()).toEqual(['First chat', 'Second chat', 'Third chat']);
  for (const chat of chats) {
    expect(host.archives.find((archive: any) => archive.id === chat.id)).toMatchObject({ cwd: remote.home, restorable: true, deletable: true });
  }
  const active = await daemon.invoke('list_sessions');
  expect(active.filter((row: any) => chats.some(chat => chat.id === row.id))).toEqual([]);
}, 60000);


test('remote archiving refuses a file outside the chat storage', async () => {
  const outside = join(remote.home, 'outside-archive.jsonl');
  writeFileSync(outside, 'precious');
  await expect(archive(outside)).rejects.toThrow('Only piop session files');
  expect(readFileSync(outside, 'utf8')).toBe('precious');
});

test('remote archiving refuses a symbolic link to a file outside chat storage', async () => {
  const chat = publish('Keep this chat');
  const outside = join(remote.home, 'outside-through-link.jsonl');
  writeFileSync(outside, 'precious');
  const alias = join(dirname(chat.path), 'outside-link.jsonl');
  symlinkSync(outside, alias);
  await expect(archive(alias)).rejects.toThrow('Only piop session files');
  expect(readFileSync(outside, 'utf8')).toBe('precious');
});

test('remote archiving refuses the filesystem root', async () => {
  await expect(archive('/')).rejects.toThrow('Only piop session files');
});


test('remote archiving preserves the active chat when storage cannot be written', async () => {
  const earlier = publish('Previously archived');
  await archive(earlier.path);
  const before = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id);
  const archiveDirectory = dirname(before.archives.find((row: any) => row.id === earlier.id).path);
  const chat = publish('Keep until storage is writable');
  const mode = statSync(archiveDirectory).mode & 0o777;
  chmodSync(archiveDirectory, 0o500);
  try {
    await expect(archive(chat.path)).rejects.toThrow(/EACCES|Permission denied/);
  } finally { chmodSync(archiveDirectory, mode); }
  const active = await daemon.invoke('list_sessions');
  expect(active.find((row: any) => row.id === chat.id)).toMatchObject({ hostId: remote.id });
  const after = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id);
  expect(after.archives.map((row: any) => row.id).sort()).toEqual(before.archives.map((row: any) => row.id).sort());
  await archive(chat.path);
  const retried = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id);
  expect(retried.archives.find((row: any) => row.id === chat.id)).toMatchObject({ name: 'Keep until storage is writable', restorable: true });
}, 60000);
