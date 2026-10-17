import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';

function missingChat(daemon: TestDaemon): { id: string; path: string; cwd: string } {
  const cwd = join(daemon.home, 'removed-project');
  mkdirSync(cwd);
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home: daemon.home, cwd, content: JSON.stringify({ type: 'message', id: 'question', parentId: null,
      message: { role: 'user', content: 'Keep my research notes', timestamp: 1 } }) + '\n' }),
  }));
  rmdirSync(cwd);
  return { ...chat, cwd };
}

const recover = (daemon: TestDaemon, path: string) => daemon.invoke('recover_missing_session', {
  sessionPath: path, hostId: 'local', action: 'empty', clientId: 'recovery-test',
});

test('recovering a missing project gives the chat an empty directory and keeps its messages', async () => {
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

test('recovery refuses a broken symbolic link at the original project path', async () => {
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

test('chats from the same missing project recover into separate directories', async () => {
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

test('recovery refuses a project that exists again and leaves the chat and files unchanged', async () => {
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

test('retrying recovery after restart reuses the directory and keeps work saved there', async () => {
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
