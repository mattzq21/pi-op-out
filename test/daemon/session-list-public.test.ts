import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, waitForSessions, type TestDaemon } from './harness';

function publicChat(home: string, content: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, content }),
  }));
}

test.concurrent('session summaries identify the host despite conflicting transcript fields', async () => {
  const fresh = await startDaemon();
  try {
    const chat = publicChat(fresh.home, [
      { type: 'session_info', name: 'Indexed', hostId: 'untrusted', hostName: 'Untrusted', fingerprint: 'untrusted' },
      { type: 'message', message: { role: 'user', content: 'Question' } },
      { type: 'message', message: { role: 'assistant', content: 'Answer', usage: { cost: { total: 0.25 } } } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const [header, ...entries] = readFileSync(chat.path, 'utf8').split('\n');
    writeFileSync(chat.path, [JSON.stringify({ ...JSON.parse(header!), hostId: 'untrusted', hostName: 'Untrusted', fingerprint: 'untrusted' }), ...entries].join('\n'));
    const [row] = await fresh.invoke('list_sessions');
    expect(row).toMatchObject({ id: chat.id, path: chat.path, name: 'Indexed', preview: 'Answer', messageCount: 2, apiCost: 0.25, hostId: 'local', hostName: 'Local' });
    expect(row).not.toHaveProperty('fingerprint');
  } finally { await fresh.stop(); }
}, 60000);

test.concurrent('an empty session list shows a newly published chat', async () => {
  const fresh = await startDaemon();
  try {
    expect(await fresh.invoke('list_sessions')).toEqual([]);
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home: fresh.home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'A new chat' } }) + '\n' }),
    }));
    const rows = await fresh.invoke('list_sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: chat.id, path: chat.path, preview: 'A new chat', messageCount: 1, hostId: 'local', hostName: 'Local' });
  } finally { await fresh.stop(); }
}, 60000);

test.concurrent('a chat at the filesystem root uses the default project name', async () => {
  const fresh = await startDaemon();
  try {
    const chat = publicChat(fresh.home, JSON.stringify({ type: 'message', message: { role: 'user', content: 'Root project' } }) + '\n');
    const [header, ...entries] = readFileSync(chat.path, 'utf8').split('\n');
    writeFileSync(chat.path, [JSON.stringify({ ...JSON.parse(header!), cwd: '/' }), ...entries].join('\n'));
    const rows = await fresh.invoke('list_sessions');
    expect(rows.find((row: any) => row.id === chat.id)).toMatchObject({ cwd: '/', project: 'Workspace' });
  } finally { await fresh.stop(); }
}, 60000);


test.concurrent('session ordering uses file change times instead of transcript fields', async () => {
  const fresh = await startDaemon();
  try {
    const older = publicChat(fresh.home, JSON.stringify({ type: 'message', message: { role: 'user', content: 'Older' } }) + '\n');
    const newer = publicChat(fresh.home, JSON.stringify({ type: 'message', message: { role: 'user', content: 'Newer' } }) + '\n');
    for (const [chat, modifiedAt, seconds] of [[older, 999999, 100], [newer, 1, 200]] as const) {
      const [header, ...entries] = readFileSync(chat.path, 'utf8').split('\n');
      writeFileSync(chat.path, [JSON.stringify({ ...JSON.parse(header!), modifiedAt }), ...entries].join('\n'));
      utimesSync(chat.path, seconds, seconds);
    }
    expect((await fresh.invoke('list_sessions')).map((row: any) => row.id)).toEqual([newer.id, older.id]);
  } finally { await fresh.stop(); }
}, 60000);

test.concurrent('a chat renamed in a running agent keeps one row with the new name for other clients and after restart, and leaves the list when archived', async () => {
  let daemon = await startDaemon();
  try {
    const chat = publicChat(daemon.home, JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Original question' } }) + '\n');
    const other = await daemon.connect();
    expect((await other.invoke('list_sessions')).filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Original question', messageCount: 1 }]);
    const runtimeId = crypto.randomUUID();
    await daemon.invoke('start_pi', { runtimeId, clientId: 'rename-owner', cwd: daemon.home, sessionPath: chat.path });
    const transcript = readFileSync(chat.path, 'utf8');
    await daemon.invoke('pi_command', { runtimeId, command: { type: 'set_session_name', name: 'Renamed chat' } });
    expect(readFileSync(chat.path, 'utf8')).toBe(transcript);
    const seen = await waitForSessions(other as TestDaemon, rows => rows.some(row => row.id === chat.id && row.name === 'Renamed chat'));
    expect(seen.filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Renamed chat', messageCount: 1 }]);
    await daemon.invoke('stop_pi', { runtimeId });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });
    expect((await daemon.invoke('list_sessions')).filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Renamed chat', messageCount: 1 }]);
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'rename-owner' });
    expect((await daemon.invoke('list_sessions')).filter((row: any) => row.id === chat.id)).toEqual([]);
    const report = await daemon.invoke('storage_report');
    expect(report.hosts.find((host: any) => host.hostId === 'local').archives.find((row: any) => row.id === chat.id).name).toBe('Renamed chat');
  } finally { await daemon.stop(); }
}, 60000);

test.concurrent('a blank rename in a running agent is rejected, keeps the custom name for other clients, and a valid retry shows for other clients and after restart', async () => {
  let daemon = await startDaemon();
  try {
    const chat = publicChat(daemon.home, [
      { type: 'session_info', id: 'name', parentId: null, name: 'Kept name' },
      { type: 'message', id: 'question', parentId: 'name', message: { role: 'user', content: 'Original question' } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const other = await daemon.connect();
    expect((await other.invoke('list_sessions')).filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Kept name', messageCount: 1 }]);
    const runtimeId = crypto.randomUUID();
    await daemon.invoke('start_pi', { runtimeId, clientId: 'rename-owner', cwd: daemon.home, sessionPath: chat.path });
    expect(await daemon.failure('pi_command', { runtimeId, command: { type: 'set_session_name', name: ' \t ' } })).toContain('Session name cannot be empty');
    expect((await other.invoke('list_sessions')).filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Kept name', messageCount: 1 }]);
    await daemon.invoke('pi_command', { runtimeId, command: { type: 'set_session_name', name: 'Retried name' } });
    const seen = await waitForSessions(other as TestDaemon, rows => rows.some(row => row.id === chat.id && row.name === 'Retried name'));
    expect(seen.filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Retried name', messageCount: 1 }]);
    await daemon.invoke('stop_pi', { runtimeId });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });
    expect((await daemon.invoke('list_sessions')).filter((row: any) => row.id === chat.id)).toMatchObject([{ path: chat.path, name: 'Retried name', messageCount: 1 }]);
  } finally { await daemon.stop(); }
}, 60000);
