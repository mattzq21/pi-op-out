import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeProgram, remoteMachine, startDaemon, temporaryDirectory, useRemotes, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop());

/** A fake Codex app server: it answers each request with the saved body for its method and the request's id. */
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
    expect(await daemon.failure('codex_usage'), expected).toContain(expected);
  }
});

test('Codex usage reports a Codex program that cannot start', async () => {
  // The user install location comes before PATH; a file there that cannot run must fail the request.
  const installed = join(daemon.home, '.local/bin/codex');
  mkdirSync(join(daemon.home, '.local/bin'), { recursive: true });
  writeFileSync(installed, FAKE_CODEX);
  chmodSync(installed, 0o644);
  try { expect(await daemon.failure('codex_usage')).toStartWith('Could not start Codex:'); }
  finally { rmSync(installed); }
});

/** A fake file manager launcher: it records each call in $HOME and fails when $HOME/.xdg-open-fail exists. */
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
