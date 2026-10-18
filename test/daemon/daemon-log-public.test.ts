import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { daemonExecutable, temporaryDirectory } from './harness';

const MAX = 10 * 1024 * 1024;

/** Feeds text to the daemon log collector for a folder, as the daemon feeds it its output, and returns the status lines it reports. */
async function collect(directory: string, chunks: string[]) {
  const child = spawn(await daemonExecutable(), ['--daemon-log-sink', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  let exited = false;
  void closed.then(() => { exited = true; });
  for (let tries = 0; !stdout.includes('ready\n') && !exited && tries < 200; tries++) await Bun.sleep(25);
  if (!exited) { for (const chunk of chunks) child.stdin.write(chunk); child.stdin.end(); }
  const code = await closed;
  const statuses = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  return { code, statuses, stderr };
}

test('daemon output is kept in daemon.log, which rolls over at 10 MB and keeps four older files', async () => {
  const directory = temporaryDirectory('piop-daemon-log-');
  const first = await collect(directory, ['first line\n', 'x'.repeat(MAX - 'first line\n'.length), 'tail line\n']);
  expect(first.code).toBe(0);
  expect(readFileSync(join(directory, 'daemon.log.1'), 'utf8').startsWith('first line\n')).toBe(true);
  expect(statSync(join(directory, 'daemon.log.1')).size).toBe(MAX);
  expect(readFileSync(join(directory, 'daemon.log'), 'utf8')).toBe('tail line\n');

  for (let round = 0; round < 5; round++) expect((await collect(directory, ['y'.repeat(MAX)])).code).toBe(0);
  expect([1, 2, 3, 4].map(index => existsSync(join(directory, 'daemon.log.' + index)))).toEqual([true, true, true, true]);
  expect(existsSync(join(directory, 'daemon.log.5'))).toBe(false);
}, 120000);

test('a daemon log that cannot be written is reported, and the collector stops instead of losing output without a word', async () => {
  const directory = temporaryDirectory('piop-daemon-log-');
  expect((await collect(directory, ['before\n'])).code).toBe(0);
  chmodSync(join(directory, 'daemon.log'), 0o400);
  try {
    const blocked = await collect(directory, ['lost line\n']);
    expect(blocked.statuses).toEqual([{ error: expect.stringContaining('EACCES') }]);
    expect(blocked.code).toBe(1);
  } finally { chmodSync(join(directory, 'daemon.log'), 0o600); }
}, 60000);
