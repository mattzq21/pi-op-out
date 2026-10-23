import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startDaemon } from './harness';

test.concurrent('opening an unregistered transcript rejects it without changing the file', async () => {
  const daemon = await startDaemon();
  try {
    const directory = join(daemon.home, '.piop', 'sessions', 'unregistered');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'chat.jsonl');
    const body = JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd: daemon.home }) + '\n';
    writeFileSync(path, body);
    expect(await daemon.failure('start_pi', { runtimeId: crypto.randomUUID(), clientId: 'session-validation', cwd: daemon.home, sessionPath: path })).toContain('Session path is not registered');
    expect(readFileSync(path, 'utf8')).toBe(body);
  } finally { await daemon.stop(); }
}, 60000);

async function rejectsHeader(header: string, reason: string) {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const body = header + '\n{"id":"later-id"}\n';
    writeFileSync(chat.path, body);
    expect(await daemon.failure('start_pi', { runtimeId: crypto.randomUUID(), clientId: 'session-validation', cwd: daemon.home, sessionPath: chat.path })).toContain(reason);
    expect(readFileSync(chat.path, 'utf8')).toBe(body);
  } finally { await daemon.stop(); }
}

test.concurrent('opening a transcript without an identity rejects it and preserves its contents', () => rejectsHeader('{}', 'Missing session identity'), 60000);

test.concurrent('opening a transcript with numeric identity rejects it without changing the file', () => rejectsHeader('{"type":"session","id":42}', 'Missing session identity'), 60000);

test.concurrent('opening a transcript with invalid JSON rejects it without changing the file', () => rejectsHeader('not json', 'JSON Parse error'), 60000);

test.concurrent('opening a transcript with empty header rejects it without changing the file', () => rejectsHeader('', 'JSON Parse error'), 60000);

test.concurrent('opening a transcript with oversized header rejects it without changing the file', () => rejectsHeader(JSON.stringify({ type: 'session', id: crypto.randomUUID(), padding: 'x'.repeat(64 * 1024) }), 'JSON Parse error'), 60000);

test.concurrent('opening a registered transcript accepts a header of exactly 64 KiB', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const header = JSON.parse(readFileSync(chat.path, 'utf8').split('\n')[0]!);
    const prefix = JSON.stringify({ ...header, padding: '' });
    const body = JSON.stringify({ ...header, padding: 'x'.repeat(65536 - Buffer.byteLength(prefix)) }) + '\n';
    expect(Buffer.byteLength(body) - 1).toBe(65536);
    writeFileSync(chat.path, body);
    const runtimeId = crypto.randomUUID();
    expect(await daemon.invoke('start_pi', { runtimeId, clientId: 'session-validation', cwd: daemon.home, sessionPath: chat.path })).toMatchObject({ owned: true });
    await daemon.invoke('stop_pi', { runtimeId });
    expect(readFileSync(chat.path, 'utf8').split('\n')[0] + '\n').toBe(body);
  } finally { await daemon.stop(); }
}, 60000);

test.concurrent('opening a registered transcript with a damaged body reports the bad line, preserves the file and leaves the runtime free for a retry', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const original = readFileSync(chat.path, 'utf8');
    const body = original + 'invalid body\r\n{"id":"wrong-message-id"}\n';
    writeFileSync(chat.path, body);
    const runtimeId = crypto.randomUUID();
    const start = { runtimeId, clientId: 'session-validation', cwd: daemon.home, sessionPath: chat.path };
    expect(await daemon.failure('start_pi', start)).toContain('Damaged chat record at line 2: ' + chat.path);
    expect(readFileSync(chat.path, 'utf8')).toBe(body);

    writeFileSync(chat.path, original);
    expect(await daemon.invoke('start_pi', start)).toMatchObject({ owned: true });
    await daemon.invoke('pi_command', { runtimeId, command: { type: 'set_session_name', name: 'Repaired transcript' } });
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state).toMatchObject({ sessionFile: chat.path, sessionId: chat.id, sessionName: 'Repaired transcript' });
    await daemon.invoke('stop_pi', { runtimeId });
  } finally { await daemon.stop(); }
}, 60000);

test.concurrent('a failed open of a damaged transcript by one client does not block another connected client from opening the repaired chat', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const original = readFileSync(chat.path, 'utf8');
    const body = original + 'invalid body\n';
    writeFileSync(chat.path, body);
    const first = { runtimeId: crypto.randomUUID(), clientId: 'session-validation-a', cwd: daemon.home, sessionPath: chat.path };
    expect(await daemon.failure('start_pi', first)).toContain('Damaged chat record at line 2: ' + chat.path);
    expect(readFileSync(chat.path, 'utf8')).toBe(body);

    writeFileSync(chat.path, original);
    const other = await daemon.connect();
    const runtimeId = crypto.randomUUID();
    expect(await other.invoke('start_pi', { runtimeId, clientId: 'session-validation-b', cwd: daemon.home, sessionPath: chat.path })).toMatchObject({ owned: true });
    await other.invoke('pi_command', { runtimeId, command: { type: 'set_session_name', name: 'Repaired by another client' } });
    const state = await other.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state).toMatchObject({ sessionFile: chat.path, sessionId: chat.id, sessionName: 'Repaired by another client' });
    await other.invoke('stop_pi', { runtimeId });
  } finally { await daemon.stop(); }
}, 60000);
