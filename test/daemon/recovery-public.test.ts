import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';

function projectChat(daemon: TestDaemon): { id: string; path: string; cwd: string } {
  const cwd = join(daemon.home, 'removed-project');
  mkdirSync(cwd, { recursive: true });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home: daemon.home, cwd, content: JSON.stringify({ type: 'message', id: 'question', parentId: null,
      message: { role: 'user', content: 'Keep my research notes', timestamp: 1 } }) + '\n' }),
  }));
  return { ...chat, cwd };
}

function missingChat(daemon: TestDaemon): { id: string; path: string; cwd: string } {
  const chat = projectChat(daemon);
  rmdirSync(chat.cwd);
  return chat;
}

const recover = (daemon: TestDaemon, path: string) => daemon.invoke('recover_missing_session', {
  sessionPath: path, hostId: 'local', action: 'empty', clientId: 'recovery-test',
});

test.concurrent('recovering a missing project gives the chat an empty directory and keeps its messages', async () => {
  const daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.id === chat.id))
      .toMatchObject({ cwd: chat.cwd, cwdExists: false });
    const result = await recover(daemon, chat.path);
    expect(result.warnings).toEqual([]);
    expect(result.cwd).not.toBe(chat.cwd);
    expect(readdirSync(result.cwd)).toEqual([]);
    expect(await daemon.invoke('list_sessions')).toEqual([expect.objectContaining({
      id: chat.id, path: chat.path, cwd: result.cwd, cwdExists: true,
      preview: 'Keep my research notes', messageCount: 1,
    })]);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('another client learns about a recovered directory through the session change event', async () => {
  const daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    const other = await daemon.connect();
    expect((await other.invoke('list_sessions')).find((row: any) => row.id === chat.id))
      .toMatchObject({ cwd: chat.cwd, cwdExists: false });
    other.events.length = 0;

    const recovered = await recover(daemon, chat.path);
    await other.waitEvent('pi://sessions-changed');
    expect((await other.invoke('list_sessions')).find((row: any) => row.id === chat.id))
      .toMatchObject({ cwd: recovered.cwd, cwdExists: true, preview: 'Keep my research notes' });
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('failed recovery preserves the chat and permits retry after the storage obstruction is removed', async () => {
  const daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    const before = await daemon.invoke('list_sessions');
    const obstruction = join(daemon.home, '.piop', 'recovery');
    writeFileSync(obstruction, 'Keep this file');

    expect(await daemon.failure('recover_missing_session', {
      sessionPath: chat.path, hostId: 'local', action: 'empty', clientId: 'recovery-test',
    })).toContain('Recovery directory is not a regular directory');
    expect(await daemon.invoke('list_sessions')).toEqual(before);
    expect(readFileSync(obstruction, 'utf8')).toBe('Keep this file');

    unlinkSync(obstruction);
    const result = await recover(daemon, chat.path);
    expect(result.warnings).toEqual([]);
    expect(await daemon.invoke('list_sessions')).toEqual([expect.objectContaining({
      id: chat.id, cwd: result.cwd, cwdExists: true, messageCount: 1, preview: 'Keep my research notes',
    })]);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('recovery refuses a broken symbolic link at the original project path', async () => {
  const daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    const target = join(daemon.home, 'unavailable-project');
    symlinkSync(target, chat.cwd);
    const before = await daemon.invoke('list_sessions');

    expect(await daemon.failure('recover_missing_session', {
      sessionPath: chat.path, hostId: 'local', action: 'empty', clientId: 'recovery-test',
    })).toContain('The session directory exists again');
    expect(await daemon.invoke('list_sessions')).toEqual(before);
    expect(readlinkSync(chat.cwd)).toBe(target);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('chats from the same missing project recover into separate directories', async () => {
  const daemon = await startDaemon();
  try {
    const first = missingChat(daemon);
    const second = missingChat(daemon);
    expect(first.cwd).toBe(second.cwd);
    const recoveredFirst = await recover(daemon, first.path);
    writeFileSync(join(recoveredFirst.cwd, 'notes.txt'), 'First chat notes');

    const recoveredSecond = await recover(daemon, second.path);
    expect(recoveredSecond.cwd).not.toBe(recoveredFirst.cwd);
    expect(readdirSync(recoveredSecond.cwd)).toEqual([]);
    writeFileSync(join(recoveredSecond.cwd, 'notes.txt'), 'Second chat notes');
    expect(readFileSync(join(recoveredFirst.cwd, 'notes.txt'), 'utf8')).toBe('First chat notes');

    const rows = await daemon.invoke('list_sessions');
    expect(rows).toHaveLength(2);
    expect(rows.find((row: any) => row.id === first.id)).toMatchObject({ cwd: recoveredFirst.cwd, cwdExists: true });
    expect(rows.find((row: any) => row.id === second.id)).toMatchObject({ cwd: recoveredSecond.cwd, cwdExists: true });
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('recovery refuses a project that exists again and leaves the chat and files unchanged', async () => {
  const daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    mkdirSync(chat.cwd);
    writeFileSync(join(chat.cwd, 'notes.txt'), 'Restored project data');
    const before = await daemon.invoke('list_sessions');

    expect(await daemon.failure('recover_missing_session', {
      sessionPath: chat.path, hostId: 'local', action: 'empty', clientId: 'recovery-test',
    })).toContain('The session directory exists again');
    expect(await daemon.invoke('list_sessions')).toEqual(before);
    expect(readFileSync(join(chat.cwd, 'notes.txt'), 'utf8')).toBe('Restored project data');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('retrying recovery after restart reuses the directory and keeps work saved there', async () => {
  let daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    const recovered = await recover(daemon, chat.path);
    writeFileSync(join(recovered.cwd, 'notes.txt'), 'Research continued after recovery');
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });

    const retried = await recover(daemon, chat.path);
    expect(retried.cwd).toBe(recovered.cwd);
    expect(retried.warnings).toEqual([]);
    expect(readFileSync(join(retried.cwd, 'notes.txt'), 'utf8')).toBe('Research continued after recovery');
    expect(await daemon.invoke('list_sessions')).toEqual([expect.objectContaining({
      id: chat.id, cwd: recovered.cwd, cwdExists: true, preview: 'Keep my research notes', messageCount: 1,
    })]);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('concurrent recovery from another client is refused while the first recovery gives the chat one directory', async () => {
  const daemon = await startDaemon();
  try {
    const chat = missingChat(daemon);
    const other = await daemon.connect();
    const request = (clientId: string) => ({ sessionPath: chat.path, hostId: 'local', action: 'empty', clientId });

    const results = await Promise.allSettled([
      daemon.invoke('recover_missing_session', request('desktop')),
      other.invoke('recover_missing_session', request('phone')),
    ]);

    const rows = await daemon.invoke('list_sessions');
    expect(rows).toEqual([expect.objectContaining({ id: chat.id, cwdExists: true, messageCount: 1 })]);
    expect(readdirSync(rows[0].cwd)).toEqual([]);
    const accepted = results.filter(result => result.status === 'fulfilled');
    const refused = results.filter(result => result.status === 'rejected');
    expect(accepted.map(result => result.value.cwd)).toEqual([rows[0].cwd]);
    expect(refused.map(result => String(result.reason))).toEqual([expect.stringContaining('Take ownership of this conversation before changing it')]);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('recovery is refused while another client has the chat open and succeeds after that client closes it', async () => {
  const daemon = await startDaemon();
  try {
    const chat = projectChat(daemon);
    expect(await daemon.invoke('start_pi', { runtimeId: 'owner-runtime', clientId: 'owner-client', cwd: chat.cwd, sessionPath: chat.path }))
      .toMatchObject({ owned: true });
    rmdirSync(chat.cwd);
    const before = await daemon.invoke('list_sessions');
    expect(before).toEqual([expect.objectContaining({ id: chat.id, cwd: chat.cwd, cwdExists: false })]);

    expect(await daemon.failure('recover_missing_session', {
      sessionPath: chat.path, hostId: 'local', action: 'empty', clientId: 'recovery-test',
    })).toContain('Take ownership of this conversation before changing it');
    expect(await daemon.invoke('list_sessions')).toEqual(before);

    await daemon.invoke('stop_pi', { runtimeId: 'owner-runtime' });
    const result = await recover(daemon, chat.path);
    expect(result.warnings).toEqual([]);
    expect(readdirSync(result.cwd)).toEqual([]);
    expect(await daemon.invoke('list_sessions')).toEqual([expect.objectContaining({
      id: chat.id, cwd: result.cwd, cwdExists: true, preview: 'Keep my research notes', messageCount: 1,
    })]);
  } finally { await daemon.stop(); }
}, 60_000);
