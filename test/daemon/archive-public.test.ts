import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, symlinkSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
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


test('repeating a finished remote archive fails and keeps earlier archives, other chats and the restorable original', async () => {
  const earlier = publish('Archived before');
  await archive(earlier.path);
  const other = publish('Unrelated active chat');
  const chat = publish('Archive twice');
  await archive(chat.path);
  await expect(archive(chat.path)).rejects.toThrow('Could not locate session file');
  const archives = await remoteArchives();
  expect(archives.filter((row: any) => [earlier.id, chat.id].includes(row.id)).map((row: any) => [row.name, row.restorable]).sort())
    .toEqual([['Archive twice', true], ['Archived before', true]]);
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === other.id));
  expect(active.filter((row: any) => [other.id, chat.id].includes(row.id))).toMatchObject([{ hostId: remote.id, name: 'Unrelated active chat' }]);
  await restore(archives.find((row: any) => row.id === chat.id).path);
  await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  const runtimeId = crypto.randomUUID();
  await daemon.invoke('start_pi', { runtimeId, clientId: 'archive-reader', hostId: remote.id, sessionPath: chat.path, cwd: remote.home, presence: { readOnly: true } });
  try {
    const history = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_entries' } });
    expect(history.entries).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Archive twice' } }]);
  } finally { await daemon.invoke('stop_pi', { runtimeId }); }
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
  try {
    await expect(archive(alias)).rejects.toThrow('Only piop session files');
    expect(readFileSync(outside, 'utf8')).toBe('precious');
  } finally { unlinkSync(alias); }
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
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  expect(active.find((row: any) => row.id === chat.id)).toMatchObject({ hostId: remote.id });
  const after = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id);
  expect(after.archives.map((row: any) => row.id).sort()).toEqual(before.archives.map((row: any) => row.id).sort());
  await archive(chat.path);
  const retried = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id);
  expect(retried.archives.find((row: any) => row.id === chat.id)).toMatchObject({ name: 'Keep until storage is writable', restorable: true });
}, 60000);

const restore = (path: string) => daemon.invoke('restore_archived_session', { hostId: remote.id, sessionPath: path, clientId: 'archive-test' });
const remoteArchives = async () => (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === remote.id).archives;

test('remote restore blocked by an occupied destination keeps the archive and the occupant, then succeeds when retried', async () => {
  const chat = publish('Restore after conflict');
  await archive(chat.path);
  const archived = (await remoteArchives()).find((row: any) => row.id === chat.id);
  writeFileSync(chat.path, 'occupant');
  await expect(restore(archived.path)).rejects.toThrow('Restoration destination already exists');
  expect(readFileSync(chat.path, 'utf8')).toBe('occupant');
  expect((await remoteArchives()).find((row: any) => row.id === chat.id)).toMatchObject({ name: 'Restore after conflict', restorable: true });
  unlinkSync(chat.path);
  await restore(archived.path);
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  expect(active.find((row: any) => row.id === chat.id)).toMatchObject({ hostId: remote.id, name: 'Restore after conflict' });
  expect((await remoteArchives()).some((row: any) => row.id === chat.id)).toBe(false);
  const runtimeId = crypto.randomUUID();
  await daemon.invoke('start_pi', { runtimeId, clientId: 'archive-reader', hostId: remote.id, sessionPath: chat.path, cwd: remote.home, presence: { readOnly: true } });
  try {
    const history = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_entries' } });
    expect(history.entries).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Restore after conflict' } }]);
  } finally { await daemon.invoke('stop_pi', { runtimeId }); }
}, 60000);

async function historyOf(path: string) {
  const runtimeId = crypto.randomUUID();
  await daemon.invoke('start_pi', { runtimeId, clientId: 'archive-reader', hostId: remote.id, sessionPath: path, cwd: remote.home, presence: { readOnly: true } });
  try { return (await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_entries' } })).entries; }
  finally { await daemon.invoke('stop_pi', { runtimeId }); }
}

test('remote restore blocked by a read-only destination folder keeps the archive and the other chat, then succeeds when retried', async () => {
  const folder = 'restore-blocked';
  const other = publish('Neighbour stays active', folder);
  const chat = publish('Restore after permission fix', folder);
  await archive(chat.path);
  const archived = (await remoteArchives()).find((row: any) => row.id === chat.id);
  const parent = dirname(chat.path);
  const mode = statSync(parent).mode & 0o777;
  chmodSync(parent, 0o500);
  try {
    await expect(restore(archived.path)).rejects.toThrow(/EACCES|Permission denied/);
    expect((await remoteArchives()).find((row: any) => row.id === chat.id)).toMatchObject({ name: 'Restore after permission fix', restorable: true });
    const active = await waitForSessions(daemon, rows => rows.some(row => row.id === other.id));
    expect(active.filter((row: any) => [other.id, chat.id].includes(row.id))).toMatchObject([{ hostId: remote.id, name: 'Neighbour stays active' }]);
    expect(await historyOf(other.path)).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Neighbour stays active' } }]);
  } finally { chmodSync(parent, mode); }
  await restore(archived.path);
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  expect(active.find((row: any) => row.id === chat.id)).toMatchObject({ hostId: remote.id, name: 'Restore after permission fix' });
  expect((await remoteArchives()).some((row: any) => row.id === chat.id)).toBe(false);
  expect(await historyOf(chat.path)).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Restore after permission fix' } }]);
}, 60000);

test('repeating a finished remote restore succeeds and keeps one active chat', async () => {
  const chat = publish('Restore twice');
  await archive(chat.path);
  const archived = (await remoteArchives()).find((row: any) => row.id === chat.id);
  await restore(archived.path);
  await restore(archived.path);
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  expect(active.filter((row: any) => row.id === chat.id)).toMatchObject([{ hostId: remote.id, name: 'Restore twice' }]);
  expect((await remoteArchives()).some((row: any) => row.id === chat.id)).toBe(false);
}, 60000);

test('repeating a finished remote restore after both daemons restart succeeds and keeps one active chat', async () => {
  const chat = publish('Restore across restart');
  await archive(chat.path);
  const archived = (await remoteArchives()).find((row: any) => row.id === chat.id);
  await restore(archived.path);
  const home = daemon.home;
  await remote.stop();
  await daemon.stop();
  daemon = await startDaemon({ home });
  await restore(archived.path);
  const active = await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  expect(active.filter((row: any) => row.id === chat.id)).toMatchObject([{ hostId: remote.id, name: 'Restore across restart' }]);
  expect((await remoteArchives()).some((row: any) => row.id === chat.id)).toBe(false);
}, 90000);
