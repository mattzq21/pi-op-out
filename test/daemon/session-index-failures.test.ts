import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fakeProgram, startDaemon } from './harness';

test('session listing reports a shell launch failure and reads the new chat after recovery', async () => {
  const daemon = await startDaemon();
  try {
    const publish = (content: string) => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content }), timeout: 30000,
    }));
    const first = publish('');
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === first.path)).toMatchObject({ id: first.id, messageCount: 0 });
    const chat = publish(JSON.stringify({ type: 'message', id: crypto.randomUUID(), parentId: null, message: { role: 'user', content: 'Read this after recovery', timestamp: 1000 } }) + '\n');
    const original = readFileSync(chat.path, 'utf8');
    const shell = fakeProgram(daemon.bin, 'sh', '#!/bin/sh\nprintf "shell launch denied\\n" >&2\nexit 3\n');
    try {
      const failure = await daemon.failure('list_sessions');
      expect(failure).toContain('start was not confirmed');
      expect(failure).toContain('shell launch denied');
      expect(readFileSync(chat.path, 'utf8')).toBe(original);
    } finally { rmSync(shell); }
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === chat.path)).toMatchObject({
      id: chat.id, messageCount: 1, preview: 'Read this after recovery',
    });
  } finally { await daemon.stop(); }
}, 60000);

test('session listing rejects an unrequested path added through the script input pipe', async () => {
  const daemon = await startDaemon();
  try {
    const publish = () => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const first = publish();
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === first.path)).toMatchObject({ id: first.id });
    const chat = publish();
    const injected = join(daemon.home, 'unregistered.jsonl');
    const body = JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd: daemon.home }) + '\n';
    writeFileSync(injected, body);
    const shell = fakeProgram(daemon.bin, 'sh', `#!${process.execPath}
const { spawn } = require('node:child_process');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
input.paths.push(${JSON.stringify(injected)});
const child = spawn('/bin/sh', process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', error => { throw error; });
child.stdin.end(JSON.stringify(input));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
`);
    try {
      expect(await daemon.failure('list_sessions')).toContain('Unexpected session summary path: ' + injected);
    } finally { rmSync(shell); }
    const rows = await daemon.invoke('list_sessions');
    expect(rows).toHaveLength(2);
    expect(rows.some((row: any) => row.path === injected)).toBe(false);
    for (const expected of [first, chat]) {
      expect(rows.find((row: any) => row.path === expected.path)).toMatchObject({ id: expected.id, name: 'Untitled session' });
    }
    expect(readFileSync(injected, 'utf8')).toBe(body);
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
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: first + second }), timeout: 30000,
    }));
    const original = readFileSync(chat.path, 'utf8');
    expect(await daemon.failure('list_sessions')).toContain('gave an invalid result');
    expect(readFileSync(chat.path, 'utf8')).toBe(original);

    writeFileSync(chat.path, original.split('\n')[0] + '\n' + first);
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === chat.path)).toMatchObject({
      id: chat.id, messageCount: 1, preview: 'First answer', apiCost: 1e308,
    });
  } finally { await daemon.stop(); }
}, 60000);

test('session listing reports a killed index process and succeeds on retry', async () => {
  const daemon = await startDaemon();
  try {
    const publish = () => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const first = publish();
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.path === first.path)).toMatchObject({ id: first.id });
    const chat = publish();
    const original = readFileSync(chat.path, 'utf8');
    const shell = fakeProgram(daemon.bin, 'sh', `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn('/bin/sh', process.argv.slice(2), { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stderr.once('data', () => child.kill('SIGKILL'));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', (code, signal) => {
  if (signal === 'SIGKILL') console.error('Script process was killed');
  else console.error('Expected a killed process, got ' + code + '/' + signal);
  process.exitCode = 1;
});
`);
    try {
      const failure = await daemon.failure('list_sessions');
      expect(failure).toContain('gave no valid reply');
      expect(failure).toContain('Script process was killed');
      expect(readFileSync(chat.path, 'utf8')).toBe(original);
    } finally { rmSync(shell); }
    const rows = await daemon.invoke('list_sessions');
    expect(rows.find((row: any) => row.path === chat.path)).toMatchObject({ id: chat.id, messageCount: 0 });
    expect(rows.find((row: any) => row.path === first.path)).toMatchObject({ id: first.id, messageCount: 0 });
  } finally { await daemon.stop(); }
}, 60000);

test('session listing reports an unreadable chat and can read it after recovery', async () => {
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
    expect(outcome).toMatchObject({ error: expect.stringContaining('EISDIR') });
    expect(outcome.error).toContain(chat.path);
  } finally { await daemon.stop(); }
}, 60000);
