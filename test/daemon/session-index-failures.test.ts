import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startDaemon } from './harness';



test('session listing excludes unregistered transcripts', async () => {
  const daemon = await startDaemon();
  try {
    const publish = () => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: JSON.stringify({ type: 'message', id: 'prompt', parentId: null, message: { role: 'user', content: 'Hello', timestamp: 1000 } }) + '\n' }), timeout: 30000,
    }));
    const first = publish();
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === first.path)).toMatchObject({ id: first.id });
    const chat = publish();
    const injected = join(daemon.home, 'unregistered.jsonl');
    const body = JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd: daemon.home }) + '\n';
    writeFileSync(injected, body);
    const rows = await daemon.invoke('list_sessions');
    expect(rows).toHaveLength(2);
    expect(rows.some((row: any) => row.path === injected)).toBe(false);
    for (const expected of [first, chat]) {
      expect(rows.find((row: any) => row.path === expected.path)).toMatchObject({ id: expected.id, name: 'Hello' });
    }
    expect(readFileSync(injected, 'utf8')).toBe(body);
  } finally { await daemon.stop(); }
}, 60000);

test('session listing leaves out a transcript with no user message or name', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    expect((await daemon.invoke('list_sessions')).some((row: any) => row.path === chat.path)).toBe(false);
  } finally { await daemon.stop(); }
}, 60000);

test('session listing rejects an invalid cost total and succeeds after the transcript is corrected', async () => {
  const daemon = await startDaemon();
  try {
    const first = JSON.stringify({ type: 'message', id: 'first', parentId: null,
      message: { role: 'assistant', content: 'First answer', timestamp: 1000, usage: { cost: { total: 1e308 } } },
    }) + '\n';
    const second = JSON.stringify({ type: 'message', id: 'second', parentId: 'first',
      message: { role: 'assistant', content: 'Second answer', timestamp: 2000, usage: { cost: { total: 1e308 } } },
    }) + '\n';
    // A transcript with no user message is listed only when it has a name.
    const name = JSON.stringify({ type: 'session_info', id: 'name', parentId: null, name: 'Costs' }) + '\n';
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: name + first + second }), timeout: 30000,
    }));
    const original = readFileSync(chat.path, 'utf8');
    expect(await daemon.failure('list_sessions')).toContain('gave an invalid result');
    expect(readFileSync(chat.path, 'utf8')).toBe(original);

    writeFileSync(chat.path, original.replace(second, ''));
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === chat.path)).toMatchObject({
      id: chat.id, messageCount: 1, preview: 'First answer', apiCost: 1e308,
    });
  } finally { await daemon.stop(); }
}, 60000);



test('session listing skips a directory and reads the restored transcript', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: JSON.stringify({
        type: 'message', id: crypto.randomUUID(), parentId: null,
        message: { role: 'user', content: 'Keep this chat', timestamp: 1000 },
      }) + '\n' }), timeout: 30000,
    }));
    const original = readFileSync(chat.path, 'utf8');
    const backup = chat.path + '.saved';
    renameSync(chat.path, backup);
    mkdirSync(chat.path);
    let outcome: { error?: string; rows?: unknown };
    try {
      outcome = await daemon.invoke('list_sessions').then(rows => ({ rows }), error => ({ error: error.message }));
      expect(readFileSync(backup, 'utf8')).toBe(original);
    } finally {
      rmSync(chat.path, { recursive: true });
      renameSync(backup, chat.path);
    }
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === chat.path)).toMatchObject({
      id: chat.id, messageCount: 1, preview: 'Keep this chat',
    });
    expect(outcome).toEqual({ rows: [] });
  } finally { await daemon.stop(); }
}, 60000);
