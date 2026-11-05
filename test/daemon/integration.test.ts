import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addProviderLogin, fakeProgram, refreshedUsage, remoteMachine, startDaemon, temporaryDirectory, useRemotes, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); addProviderLogin(daemon.home, 'openai-codex', 'oauth'); }, 60_000);
afterAll(() => daemon?.stop());

const FAKE_CODEX = `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*) body=initialize;;
    *'"method":"account/rateLimits/read"'*) body=rate-limits;;
    *) continue;;
  esac
  printf '{"id":%s%s}\\n' "$id" "$(cat "$HOME/.fake-codex/$body")"
done
`;

function codexAnswers(initialize: string, rateLimits: string): void {
  const directory = join(daemon.home, '.fake-codex');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'initialize'), initialize);
  writeFileSync(join(directory, 'rate-limits'), rateLimits);
}

test('Codex usage reports server errors and missing usage data', async () => {
  fakeProgram(daemon.bin, 'codex', FAKE_CODEX);
  const cases: Array<[string, string, string]> = [
    [',"error":{"message":"initialize denied"}', ',"result":{}', 'initialize denied'],
    [',"result":{}', ',"error":{"message":"not signed in"}', 'not signed in'],
    [',"result":{}', ',"result":{}', 'Codex usage is unavailable'],
    [',"result":{}', '', 'Codex returned no usage data'],
  ];
  for (const [initialize, rateLimits, expected] of cases) {
    codexAnswers(initialize, rateLimits);
    expect((await refreshedUsage(daemon, 'codex')).error, expected).toContain(expected);
  }
});

test('Codex usage reports a Codex program that cannot start', async () => {
  const installed = join(daemon.home, '.local/bin/codex');
  mkdirSync(join(daemon.home, '.local/bin'), { recursive: true });
  writeFileSync(installed, FAKE_CODEX);
  chmodSync(installed, 0o644);
  try { expect((await refreshedUsage(daemon, 'codex')).error).toStartWith('Could not start Codex:'); }
  finally { rmSync(installed); }
});

test('Codex usage completes the server handshake and returns the limiting window', async () => {
  fakeProgram(daemon.bin, 'codex', `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(9);
let initialized = false;
let ready = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const packet = JSON.parse(line);
  const reply = result => console.log(JSON.stringify({ id: packet.id, result }));
  const reject = message => console.log(JSON.stringify({ id: packet.id, error: { code: -32600, message } }));
  if (packet.method === 'initialize') {
    if (!packet.params?.clientInfo?.name || !packet.params.clientInfo.version) return reject('Client identity is required');
    initialized = true;
    console.log('startup noise');
    return reply({});
  }
  if (packet.method === 'initialized') { ready = initialized; return; }
  if (packet.method === 'account/rateLimits/read') {
    if (!ready) return reject('Initialize the server before reading account limits');
    return reply({ rateLimits: { primary: { usedPercent: 20, resetsAt: 100 }, secondary: { usedPercent: 75, resetsAt: 200 } } });
  }
  reject('Unsupported test server method');
});
`);
  expect((await refreshedUsage(daemon, 'codex')).usage).toEqual({ remainingPercent: 25, resetAt: 200 });
});

const FAKE_XDG_OPEN = `#!/bin/sh
printf '%s\\0' "$@" >> "$HOME/.xdg-open-calls"
[ ! -f "$HOME/.xdg-open-fail" ] || { cat "$HOME/.xdg-open-fail" >&2; exit 3; }
`;
const opened = (home: string) => { try { return readFileSync(join(home, '.xdg-open-calls'), 'utf8').split('\0').slice(0, -1); } catch { return []; } };

test('opening a project directory passes the literal path, links included, to the file manager and reports its failure', async () => {
  fakeProgram(daemon.bin, 'xdg-open', FAKE_XDG_OPEN);
  const root = temporaryDirectory('piop-open-');
  const directory = join(root, "project's $files; λ");
  mkdirSync(directory);
  const alias = join(root, 'alias');
  symlinkSync(directory, alias);
  await daemon.invoke('open_project_directory', { cwd: directory });
  await daemon.invoke('open_project_directory', { cwd: alias, hostId: 'local' });
  expect(opened(daemon.home)).toEqual([directory, alias]);
  writeFileSync(join(daemon.home, '.xdg-open-fail'), 'file manager unavailable\n');
  try { expect(await daemon.failure('open_project_directory', { cwd: directory })).toBe('Could not open ' + directory + ': xdg-open exited with code 3'); }
  finally { rmSync(join(daemon.home, '.xdg-open-fail')); }
});

test('opening a file or a missing directory is rejected before the file manager starts', async () => {
  fakeProgram(daemon.bin, 'xdg-open', FAKE_XDG_OPEN);
  const root = temporaryDirectory('piop-open-');
  const file = join(root, 'file');
  writeFileSync(file, 'contents');
  const before = opened(daemon.home);
  for (const path of [file, join(root, 'missing')]) {
    expect(await daemon.failure('open_project_directory', { cwd: path })).toBe('Project directory does not exist: ' + path);
  }
  expect(opened(daemon.home)).toEqual(before);
});

test('opening a project directory on a remote machine runs that machine’s file manager', async () => {
  fakeProgram(daemon.bin, 'xdg-open', FAKE_XDG_OPEN);
  const server = await remoteMachine(daemon, 'build', 'Build server');
  try {
    await useRemotes(daemon, [server]);
    const directory = join(server.home, "remote project's $files");
    mkdirSync(directory);
    const local = opened(daemon.home);
    await daemon.invoke('open_project_directory', { cwd: directory, hostId: 'build' });
    expect(opened(server.home)).toEqual([directory]);
    expect(opened(daemon.home)).toEqual(local);
    expect(await daemon.failure('open_project_directory', { cwd: directory, hostId: 'missing' })).toBe('Unknown host: missing');
  } finally {
    await useRemotes(daemon, []);
    await server.stop();
  }
});
