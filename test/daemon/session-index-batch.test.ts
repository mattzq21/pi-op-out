import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeProgram, startDaemon } from './harness';

test('listing many chats keeps completed results when a later process is killed', async () => {
  const daemon = await startDaemon();
  try {
    const publish = (count: number) => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat-batch.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, count }), timeout: 60000,
    })) as Array<{ id: string; path: string; preview: string }>;
    const [first] = publish(1);
    expect((await daemon.invoke('list_sessions')).some((row: any) => row.id === first!.id)).toBe(true);
    const chats = publish(501);
    const completedFile = join(daemon.home, 'completed-reads.json');
    const shell = fakeProgram(daemon.bin, 'sh', `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const completed = ${JSON.stringify(completedFile)};
const interrupt = fs.existsSync(completed);
const input = fs.readFileSync(0);
const child = spawn('/bin/sh', process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
if (interrupt) child.stderr.once('data', () => child.kill('SIGKILL'));
child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
child.stdin.end(input);
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', (code, signal) => {
  if (signal === 'SIGKILL') console.error('Later script process was killed');
  if (code === 0 && !interrupt) fs.writeFileSync(completed, JSON.stringify(JSON.parse(input).paths));
  process.exitCode = code ?? 1;
});
`);
    try {
      expect(await daemon.failure('list_sessions')).toContain('Later script process was killed');
    } finally { rmSync(shell); }

    const completed: string[] = JSON.parse(readFileSync(completedFile, 'utf8'));
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.length).toBeLessThan(chats.length);
    const protectedPaths: string[] = [];
    try {
      for (const path of completed) {
        renameSync(path, path + '.saved');
        protectedPaths.push(path);
        mkdirSync(path);
      }
      const rows = await daemon.invoke('list_sessions');
      for (const chat of [first!, ...chats]) {
        expect(rows.find((row: any) => row.path === chat.path)).toMatchObject({ id: chat.id, preview: chat.preview, messageCount: 1 });
      }
      expect(rows).toHaveLength(502);
    } finally {
      for (const path of protectedPaths) {
        rmSync(path, { recursive: true, force: true });
        renameSync(path + '.saved', path);
      }
    }
  } finally { await daemon.stop(); }
}, 120000);
