import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { daemonExecutable, fakeProgram, startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
let profile: string;

beforeAll(async () => {
  daemon = await startDaemon();
  profile = join(daemon.home, '.piop');
}, 60_000);
afterAll(() => daemon?.stop());

/** A listed chat needs a user message or a name, so the default content has one user message. */
function publicSession(home: string, cwd: string, folder: string, content = JSON.stringify({ type: 'message', message: { role: 'user', content: 'Hello' } }) + '\n'): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, cwd, folder, content }),
  }));
}

/** Allocated bytes of a file tree as reported by du. */
function allocatedBytes(path: string): number {
  const result = Bun.spawnSync(['du', '-s', '-B1', path]);
  if (result.exitCode !== 0) throw new Error('du failed: ' + result.stderr.toString());
  return Number(result.stdout.toString().split('\t')[0]);
}

// Placed first: no test has stored anything in this home yet, as on a new machine.
test('a new machine, where Pi has stored nothing yet, has a storage report without warnings', async () => {
  expect((await daemon.invoke('storage_report')).hosts[0].warnings).toEqual([]);
});

test('storage report counts real conversation files and marks malformed archives undeletable', async () => {
  publicSession(daemon.home, daemon.home, 'project');
  writeFileSync(join(profile, 'sessions/project/ignored.txt'), 'not counted');
  const toArchive = publicSession(daemon.home, daemon.home, 'project');
  await daemon.invoke('archive_session', { sessionPath: toArchive.path, hostId: 'local', terminalIds: [], clientId: 'storage-test' });
  const before = await daemon.invoke('storage_report');
  const broken = before.hosts.find((host: any) => host.hostId === 'local').archives.find((chat: any) => chat.id === toArchive.id);
  expect(broken).toBeDefined();
  writeFileSync(broken.path, 'broken');
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  writeFileSync(join(chat.cwd, 'file'), 'temporary');
  mkdirSync(join(profile, 'tmp/unowned'), { recursive: true });
  const { hosts } = await daemon.invoke('storage_report');
  expect(hosts).toHaveLength(1);
  const [local] = hosts;
  expect(local).toMatchObject({ hostId: 'local', hostName: 'Local' });
  expect(local.error).toBeUndefined();
  const category = (id: string) => local.categories.find((category: any) => category.id === id);
  expect(category('active-conversations')).toMatchObject({ itemCount: 1, byteSize: allocatedBytes(join(profile, 'sessions')) });
  expect(category('archived-conversations')).toMatchObject({ itemCount: 1, byteSize: allocatedBytes(join(profile, 'archived')) });
  expect(category('temporary-chats')).toMatchObject({ itemCount: 1, byteSize: allocatedBytes(join(profile, 'tmp')) });
  expect(local.archives).toEqual([expect.objectContaining({ path: broken.path, deletable: false, restorable: false, deleteError: expect.stringContaining('invalid chat data') })]);
});

test('storage report shows each machine under its own name and reports machines that fail', async () => {
  const remote = await startDaemon();
  try {
    const toArchive = publicSession(remote.home, remote.home, 'project', JSON.stringify({ type: 'session_info', name: 'Remote archive' }) + '\n');
    await remote.invoke('archive_session', { sessionPath: toArchive.path, hostId: 'local', terminalIds: [], clientId: 'storage-test' });
    const before = await remote.invoke('storage_report');
    const archived = before.hosts.find((host: any) => host.hostId === 'local').archives.find((chat: any) => chat.id === toArchive.id);
    expect(archived).toBeDefined();
    // Each SSH target picks one behavior. "working" runs the command on this machine as the remote daemon's user.
    fakeProgram(daemon.bin, 'ssh', `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do case "$1" in -o|-F) shift 2 ;; -*) shift ;; *) break ;; esac; done
target="$1"; shift
case "$target" in
  exit-code) exit 3 ;;
  stderr) printf 'disk failed' >&2; exit 4 ;;
  invalid) printf '{}'; exit 0 ;;
  working) HOME=${remote.home} exec bash -c "$*" ;;
esac
exit 255
`);
    const host = (id: string, name: string, piPath = 'pi') => ({ enabled: true, id, name, target: id, piPath });
    const settings = await daemon.invoke('load_app_settings');
    settings.hosts = [host('working', 'Working server', await daemonExecutable()), host('invalid', 'Invalid server'), host('stderr', 'Broken disk'), host('exit-code', 'Absent server'), { ...host('disabled', 'Disabled server'), enabled: false }];
    await daemon.invoke('save_app_settings', { settings });
    const { hosts } = await daemon.invoke('storage_report');
    expect(hosts.map((report: any) => report.hostName)).toEqual(['Local', 'Working server', 'Invalid server', 'Broken disk', 'Absent server']);
    const report = (id: string) => hosts.find((report: any) => report.hostId === id);
    expect(report('exit-code').error).toStartWith('Could not attach to Absent server');
    expect(report('stderr').error).toContain('disk failed');
    expect(report('invalid').error).toStartWith('Could not attach to Invalid server');
    for (const id of ['exit-code', 'stderr', 'invalid']) expect(report(id), id).toMatchObject({ categories: [], archives: [], warnings: [] });
    expect(report('working').error).toBeUndefined();
    expect(report('working').archives).toEqual([expect.objectContaining({ path: archived.path, name: 'Remote archive', deletable: true })]);
    expect(report('working').categories.find((category: any) => category.id === 'archived-conversations').itemCount).toBe(1);
  } finally { await remote.stop(); }
}, 120_000);

const listed = async (paths: string[]) => (await daemon.invoke('list_sessions')).filter((session: any) => paths.includes(session.path));

test('session list keeps names, counts, cost and preview for sessions on both sides of a batch limit', async () => {
  const project = join(daemon.home, 'projects/example');
  mkdirSync(project, { recursive: true });
  const contents = Array.from({ length: 501 }, (_, number) => [
    { type: 'session_info', name: 'Chat ' + number },
    { type: 'message', message: { role: 'user', content: 'Question' } },
    { type: 'message', message: { role: 'assistant', content: 'Answer 🦆', usage: { cost: { total: 0.25 } } } },
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const published: Array<{ id: string; path: string }> = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat-batch.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 60000,
    input: JSON.stringify({ home: daemon.home, cwd: project, count: 501, contents }),
  }));
  rmdirSync(project);
  const sessions = await listed(published.map(session => session.path));
  expect(sessions).toHaveLength(501);
  for (const [number, { id, path }] of published.entries()) {
    expect(sessions.find((session: any) => session.path === path), path).toMatchObject({
      id, name: 'Chat ' + number, project: 'example', cwd: project, cwdExists: false,
      messageCount: 2, apiCost: 0.25, preview: 'Answer 🦆', hostId: 'local', hostName: 'Local',
    });
  }
}, 60_000);

test('session list skips unreadable transcripts without losing valid ones', async () => {
  const damaged = ['', 'not json\n', '{"type":"message"}\n'].map(body => {
    const session = publicSession(daemon.home, daemon.home, 'damaged');
    writeFileSync(session.path, body);
    return session.path;
  });
  const missing = publicSession(daemon.home, daemon.home, 'damaged');
  rmSync(missing.path);
  const valid = publicSession(daemon.home, daemon.home, 'damaged');
  writeFileSync(valid.path, readFileSync(valid.path, 'utf8') + 'malformed line\n');
  const sessions = await listed([...damaged, missing.path, valid.path]);
  expect(sessions).toEqual([expect.objectContaining({ id: valid.id, name: 'Hello', messageCount: 1, apiCost: 0 })]);
});

test('session list follows its project folder appearing and disappearing', async () => {
  const project = join(daemon.home, 'missing project');
  mkdirSync(project);
  const { path } = publicSession(daemon.home, project, 'project-check');
  rmdirSync(project);
  const cwdExists = async () => (await listed([path]))[0].cwdExists;
  expect(await cwdExists()).toBe(false);
  mkdirSync(project);
  expect(await cwdExists()).toBe(true);
  rmdirSync(project);
  expect(await cwdExists()).toBe(false);
});

test('deleting a transcript with invalid chat data fails and keeps the file', async () => {
  const { path } = publicSession(daemon.home, daemon.home, 'delete-invalid');
  writeFileSync(path, 'invalid json');
  expect(await daemon.failure('delete_session', { sessionPath: path, hostId: 'local', clientId: 'test-client' })).toBe('This conversation has been deleted or archived');
  expect(readFileSync(path, 'utf8')).toBe('invalid json');
});

/** Installs a fake Codex app server. It gives the reply in ~/codex-reply to the usage request, closes on "close" and stays silent on "silent". */
function installFakeCodex(reply: string): void {
  writeFileSync(join(daemon.home, 'codex-reply'), reply);
  fakeProgram(daemon.bin, 'codex', `#!/usr/bin/env node
const reply = require('node:fs').readFileSync(require('node:path').join(process.env.HOME, 'codex-reply'), 'utf8');
const send = value => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 1) { send('not json'); send({ method: 'notification' }); send({ id: 3, result: false }); send({ id: 1, result: {} }); }
  if (request.id === 2) {
    if (reply === 'close') process.exit(0);
    if (reply === 'silent') return;
    send({ method: 'notification' }); send({ id: 1, result: false }); send(reply);
  }
});
`);
}

test('Codex usage skips notifications and other replies and reports Codex errors', async () => {
  const usage = async (reply: string) => { installFakeCodex(reply); return daemon.invoke('codex_usage'); };
  const failure = async (reply: string) => { installFakeCodex(reply); return daemon.failure('codex_usage'); };
  expect(await usage(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 40, resetsAt: 123 }, secondary: { usedPercent: 10 } } } }))).toEqual({ remainingPercent: 60, resetAt: 123 });
  expect(await failure(JSON.stringify({ id: 2, error: 'denied' }))).toContain('denied');
  expect(await failure(JSON.stringify({ id: 2 }))).toBe('Codex returned no usage data');
  expect(await failure('close')).toBe('Codex usage request timed out');
});

test('Codex usage times out when Codex stays silent', async () => {
  installFakeCodex('silent');
  const started = Date.now();
  expect(await daemon.failure('codex_usage')).toBe('Codex usage request timed out');
  expect(Date.now() - started).toBeGreaterThanOrEqual(7_500);
}, 30_000);

test('deletion refused for another client keeps the open conversation readable and succeeds after its owner closes it', async () => {
  const local = await startDaemon();
  try {
    const question = JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Keep while open' } }) + '\n';
    const blocked = publicSession(local.home, local.home, 'running', question);
    const ownDelete = publicSession(local.home, local.home, 'running');
    const open = (runtimeId: string, sessionPath: string, presence?: any) => local.invoke('start_pi', { runtimeId, clientId: 'test-client', cwd: local.home, sessionPath, presence });
    expect(await open('blocked-runtime', blocked.path)).toMatchObject({ owned: true });
    expect(await open('own-delete-runtime', ownDelete.path)).toMatchObject({ owned: true });
    const remove = (path: string, clientId = 'other-client') => ({ sessionPath: path, hostId: 'local', clientId });
    const listedIds = async () => (await local.invoke('list_sessions')).map((row: any) => row.id).filter((id: string) => [blocked.id, ownDelete.id].includes(id));
    expect(await local.failure('delete_session', remove(blocked.path))).toBe('Take ownership of this conversation before changing it');
    // The client that owns a running conversation may still delete it.
    expect(await local.invoke('delete_session', remove(ownDelete.path, 'test-client'))).toEqual([ownDelete.path]);
    expect(await listedIds()).toEqual([blocked.id]);
    await local.invoke('stop_pi', { runtimeId: 'blocked-runtime' });
    await open('reader-runtime', blocked.path, { readOnly: true });
    try {
      const history = await local.invoke('pi_command', { runtimeId: 'reader-runtime', command: { type: 'get_entries' } });
      expect(history.entries.filter((entry: any) => entry.type === 'message')).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Keep while open' } }]);
    } finally { await local.invoke('stop_pi', { runtimeId: 'reader-runtime' }); }
    expect(await local.invoke('delete_session', remove(blocked.path))).toEqual([blocked.path]);
    expect(await listedIds()).toEqual([]);
  } finally { await local.stop(); }
}, 60_000);

test('another client can archive a chat open by its owner, which stops the owner changing it, and restore it unchanged', async () => {
  const local = await startDaemon();
  try {
    const question = JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Archived by another client' } }) + '\n';
    const chat = publicSession(local.home, local.home, 'cross-client-archive', question);
    const open = (runtimeId: string, clientId: string, sessionPath: string, presence?: any) => local.invoke('start_pi', { runtimeId, clientId, cwd: local.home, sessionPath, presence });
    expect(await open('owner-runtime', 'owner-client', chat.path)).toMatchObject({ owned: true });
    await local.invoke('archive_session', { sessionPath: chat.path, hostId: 'local', terminalIds: [], clientId: 'other-client' });
    expect(await local.failure('pi_command', { runtimeId: 'owner-runtime', command: { type: 'prompt', message: 'after archive' } })).toBe('Take ownership of this conversation before changing it');
    const archives = (await local.invoke('storage_report')).hosts.find((host: any) => host.hostId === 'local').archives.filter((row: any) => row.id === chat.id);
    expect(archives).toEqual([expect.objectContaining({ id: chat.id, restorable: true })]);
    expect((await local.invoke('list_sessions')).some((row: any) => row.id === chat.id)).toBe(false);
    await local.invoke('restore_archived_session', { sessionPath: archives[0].path, hostId: 'local', clientId: 'other-client' });
    await open('reader-runtime', 'other-client', chat.path, { readOnly: true });
    try {
      const history = await local.invoke('pi_command', { runtimeId: 'reader-runtime', command: { type: 'get_entries' } });
      expect(history.entries.filter((entry: any) => entry.type === 'message')).toMatchObject([{ id: 'question', message: { role: 'user', content: 'Archived by another client' } }]);
    } finally { await local.invoke('stop_pi', { runtimeId: 'reader-runtime' }); }
  } finally { await local.stop(); }
}, 60_000);



function publishedChat(daemon: TestDaemon, content: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content } }) + '\n' }),
  }));
}

test.concurrent('deleting an active chat removes it from the list and preserves another chat', async () => {
  const daemon = await startDaemon();
  try {
    const target = publishedChat(daemon, 'Delete active chat');
    const other = publishedChat(daemon, 'Keep active chat');
    expect(await daemon.invoke('delete_session', { sessionPath: target.path, hostId: 'local', clientId: 'test-client' })).toEqual([target.path]);
    expect(await daemon.waitEvent('pi://session-removed', payload => payload.sessionPath === target.path)).toEqual({ hostId: 'local', sessionPath: target.path, sessionId: target.id });
    const rows = await daemon.invoke('list_sessions');
    expect(rows.filter((row: any) => [target.id, other.id].includes(row.id)).map((row: any) => row.id)).toEqual([other.id]);
  } finally { await daemon.stop(); }
}, 60000);

test.concurrent('deleting an archived chat removes it from the report and preserves another archive', async () => {
  const daemon = await startDaemon();
  try {
    const target = publishedChat(daemon, 'Delete archived chat');
    const other = publishedChat(daemon, 'Keep archived chat');
    for (const chat of [target, other]) await daemon.invoke('archive_session', { sessionPath: chat.path, hostId: 'local', terminalIds: [], clientId: 'test-client' });
    const before = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === 'local');
    const path = before.archives.find((row: any) => row.id === target.id).path;
    expect(await daemon.invoke('delete_archived_session', { sessionPath: path, hostId: 'local', clientId: 'test-client' })).toEqual([path]);
    expect(await daemon.waitEvent('pi://session-removed', payload => payload.sessionPath === path)).toEqual({ hostId: 'local', sessionPath: path, sessionId: target.id });
    const after = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === 'local');
    expect(after.archives.filter((row: any) => [target.id, other.id].includes(row.id)).map((row: any) => row.name)).toEqual(['Keep archived chat']);
  } finally { await daemon.stop(); }
}, 60000);
