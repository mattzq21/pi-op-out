import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

function publicChat(home: string, content: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, content }),
  }));
}

test('session summaries identify the host despite conflicting transcript fields', async () => {
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

test('an empty session list shows a newly published chat', async () => {
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

test('a chat at the filesystem root uses the default project name', async () => {
  const fresh = await startDaemon();
  try {
    const chat = publicChat(fresh.home, JSON.stringify({ type: 'message', message: { role: 'user', content: 'Root project' } }) + '\n');
    const [header, ...entries] = readFileSync(chat.path, 'utf8').split('\n');
    writeFileSync(chat.path, [JSON.stringify({ ...JSON.parse(header!), cwd: '/' }), ...entries].join('\n'));
    const rows = await fresh.invoke('list_sessions');
    expect(rows.find((row: any) => row.id === chat.id)).toMatchObject({ cwd: '/', project: 'Workspace' });
  } finally { await fresh.stop(); }
}, 60000);


test('session ordering uses file change times instead of transcript fields', async () => {
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
