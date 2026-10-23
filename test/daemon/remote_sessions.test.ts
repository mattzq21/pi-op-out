import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { remoteMachine, startDaemon, waitForSessions, synchronizationFinished, useRemotes, type RemoteMachine, type TestDaemon } from './harness';

let daemon: TestDaemon;
let server: RemoteMachine;

beforeAll(async () => {
  daemon = await startDaemon();
  server = await remoteMachine(daemon, 'server', 'Server');
  await useRemotes(daemon, [server]);
}, 60_000);
afterAll(async () => { await server?.stop(); await daemon?.stop(); }, 60_000);

function publicSession(home: string, options: { cwd: string; folder: string; content?: string }): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, content: '', ...options }),
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('remote directory listing preserves unusual names and sorts direct child folders', async () => {
  const root = join(server.home, "project ' ; $(false)"); mkdirSync(root, { recursive: true });
  const names = ['zebra', 'Alpha', '.hidden', 'line\nbreak', 'λ space'];
  for (const name of names) mkdirSync(join(root, name));
  mkdirSync(join(root, 'Alpha/nested'));
  writeFileSync(join(root, 'regular-file'), 'data');
  symlinkSync(join(root, 'Alpha'), join(root, 'linked-dir'));
  const listing = await daemon.invoke('list_directories', { hostId: 'server', path: root });
  expect(listing.path).toBe(realpathSync(root));
  expect(listing.parent).toBe(realpathSync(server.home));
  expect(listing.directories).toEqual(['.hidden', 'Alpha', 'line\nbreak', 'linked-dir', 'zebra', 'λ space'].map(name => join(realpathSync(root), name)));
  expect(readFileSync(join(root, 'regular-file'), 'utf8')).toBe('data');
});


for (const hostId of ['local', 'server']) {
  const home = () => hostId === 'local' ? daemon.home : server.home;

  test(hostId + ' temporary chats get empty directories that are removed only when empty', async () => {
    const first = await daemon.invoke('create_temporary_chat', { hostId });
    const second = await daemon.invoke('create_temporary_chat', { hostId });
    expect(first.sessionId).toMatch(UUID);
    expect(first.cwd).toBe(join(realpathSync(home()), '.piop/tmp', first.sessionId));
    for (const chat of [first, second]) expect(readdirSync(chat.cwd)).toEqual([]);
    mkdirSync(join(first.cwd, 'nested')); writeFileSync(join(first.cwd, 'nested/file'), 'temporary content');
    writeFileSync(join(second.cwd, 'keep'), 'other chat');
    await daemon.invoke('remove_temporary_chat', { hostId, path: first.cwd });
    expect(readFileSync(join(first.cwd, 'nested/file'), 'utf8')).toBe('temporary content');
    expect(readFileSync(join(second.cwd, 'keep'), 'utf8')).toBe('other chat');
    unlinkSync(join(first.cwd, 'nested/file')); rmdirSync(join(first.cwd, 'nested'));
    await daemon.invoke('remove_temporary_chat', { hostId, path: first.cwd });
    expect(existsSync(first.cwd)).toBe(false);
    await daemon.invoke('remove_temporary_chat', { hostId, path: first.cwd });
  });

  test(hostId + ' temporary chat removal rejects paths that were not created as temporary chats', async () => {
    for (const path of ['/tmp', join(home(), '.piop/tmp/not-a-uuid'), join(home(), 'other', crypto.randomUUID()), join(home(), '.piop/other', crypto.randomUUID())]) {
      expect(await daemon.failure('remove_temporary_chat', { hostId, path })).toContain('Refusing to remove a directory not created as a temporary chat');
    }
    const outside = join(home(), 'outside'); mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, 'keep'), 'outside');
    const link = join(home(), '.piop/tmp', crypto.randomUUID()); mkdirSync(dirname(link), { recursive: true }); symlinkSync(outside, link);
    await expect(daemon.invoke('remove_temporary_chat', { hostId, path: link })).rejects.toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside');
  });

  test(hostId + ' project validation keeps the requested path and accepts only directories', async () => {
    const project = join(home(), " project '\n λ $(false) 日本語 "); mkdirSync(project);
    const alias = join(home(), 'alias-project'); symlinkSync(project, alias);
    const file = join(home(), 'project-file'); writeFileSync(file, 'untouched');
    const dangling = join(home(), 'dangling'); symlinkSync(join(home(), 'absent'), dangling);
    const validate = (path: string) => daemon.invoke('validate_project_directory', { hostId, path });
    for (const path of [project, alias, join(project, '.')]) expect(await validate(path)).toBe(path);
    for (const blank of ['', ' ', '\t\n']) await expect(validate(blank)).rejects.toThrow("Path can't be empty");
    // A remote machine validates through its own daemon, so it reports the same errors as the local machine.
    await expect(validate(file)).rejects.toThrow('Project path is not a directory');
    for (const path of [dangling, join(home(), 'missing')]) await expect(validate(path)).rejects.toThrow('Could not open project directory:');
    expect(readFileSync(file, 'utf8')).toBe('untouched');
  });
}


test('local directory listing defaults to home, lists folders by name and resolves links', async () => {
  const home = join(daemon.home, 'listing-home'); mkdirSync(home);
  for (const name of ['zebra', 'Apple', 'beta', '.hidden']) mkdirSync(join(home, name));
  writeFileSync(join(home, 'not-a-directory'), 'file');
  const target = join(home, 'target-dir'); mkdirSync(target);
  symlinkSync(target, join(home, 'alias')); symlinkSync(join(home, 'missing'), join(home, 'broken'));
  const canonical = realpathSync(home);
  const listing = await daemon.invoke('list_directories', { hostId: 'local', path: home });
  expect(listing.path).toBe(canonical);
  expect(listing.parent).toBe(dirname(canonical));
  expect(listing.directories).toEqual(['.hidden', 'alias', 'Apple', 'beta', 'target-dir', 'zebra'].map(name => join(canonical, name)));
  for (const path of [undefined, '', ' \t']) expect((await daemon.invoke('list_directories', { hostId: 'local', path })).path).toBe(realpathSync(daemon.home));
  expect((await daemon.invoke('list_directories', { path: join(home, 'alias') })).path).toBe(realpathSync(target));
  const empty = await daemon.invoke('list_directories', { path: join(home, 'beta') });
  expect(empty).toEqual({ path: join(canonical, 'beta'), parent: canonical, directories: [] });
  expect(await daemon.failure('list_directories', { path: join(home, 'missing') })).toStartWith('Could not browse');
  expect(await daemon.failure('list_directories', { path: join(home, 'not-a-directory') })).toEndWith('is not a directory');
});

test('local directory listing reports an unreadable folder and lists it again once readable', async () => {
  const locked = join(realpathSync(daemon.home), 'unreadable-listing'); mkdirSync(join(locked, 'child'), { recursive: true });
  chmodSync(locked, 0o300);
  try {
    const failure = await daemon.failure('list_directories', { hostId: 'local', path: locked });
    expect(failure).toStartWith('Could not browse ' + locked + ':');
    expect(failure).toContain('EACCES');
  } finally { chmodSync(locked, 0o700); }
  expect(await daemon.invoke('list_directories', { hostId: 'local', path: locked }))
    .toEqual({ path: locked, parent: realpathSync(daemon.home), directories: [join(locked, 'child')] });
});

test('listing the root folder has no parent on each machine', async () => {
  for (const hostId of ['local', 'server']) {
    const listing = await daemon.invoke('list_directories', { hostId, path: '/' });
    expect(listing.path, hostId).toBe('/');
    expect(listing.parent, hostId).toBeNull();
    expect(listing.directories, hostId).toContain('/tmp');
  }
});

test('a project link that loses its folder or points at a file is rejected', async () => {
  const project = join(daemon.home, 'linked-target'); mkdirSync(project);
  const alias = join(daemon.home, 'linked-alias'); symlinkSync(project, alias);
  expect(await daemon.invoke('validate_project_directory', { path: alias })).toBe(alias);
  rmdirSync(project);
  expect(await daemon.failure('validate_project_directory', { path: alias })).toStartWith('Could not open project directory:');
  writeFileSync(project, 'now a file');
  expect(await daemon.failure('validate_project_directory', { path: alias })).toBe('Project path is not a directory');
  expect(readFileSync(project, 'utf8')).toBe('now a file');
});

test('Piop storage cannot be a project, even reached through a link', async () => {
  mkdirSync(join(daemon.home, '.piop/notes'), { recursive: true });
  const shortcut = join(daemon.home, 'storage-shortcut'); symlinkSync(join(daemon.home, '.piop/notes'), shortcut);
  for (const path of [join(daemon.home, '.piop'), join(daemon.home, '.piop/notes'), shortcut]) {
    expect(await daemon.failure('validate_project_directory', { hostId: 'local', path })).toBe('Piop storage directories cannot be selected as projects');
  }
});

test('commands for an unreachable machine report the connection failure and change nothing', async () => {
  await useRemotes(daemon, [server, { id: 'offline', name: 'Offline', target: 'offline', unreachable: true }]);
  try {
    for (const [command, args] of [
      ['home_directory', {}], ['list_directories', { path: '/project' }], ['validate_project_directory', { path: '/project' }],
      ['create_temporary_chat', {}], ['remove_temporary_chat', { path: '/home/user/.piop/tmp/' + crypto.randomUUID() }],
    ] as const) {
      expect(await daemon.failure(command, { ...args, hostId: 'offline' }), command).toStartWith('Could not attach to Offline');
    }
    expect(await daemon.failure('validate_project_directory', { hostId: 'offline', path: ' \n\t' })).toStartWith('Could not attach to Offline');
  } finally { await useRemotes(daemon, [server]); }
});


// Regression for a user-visible race, found while migrating. The save (settings.ts saveAppSettings) and the later
// synchronization pass (settings_synchronization.ts applyEffects) both call peers.invalidate, which raises the SSH
// revision even when no machine changed. A connect that read the revision before either call fails with
// "SSH settings changed for <name>; retry the command" (peers.ts connect). No client retries that error.
// This test fails on the current code because of that defect.
test('a machine command sent right after a settings save does not fail with an SSH retry error', async () => {
  const results: string[] = [];
  try {
    for (let round = 0; round < 4; round++) {
      const settings = await daemon.invoke('load_app_settings');
      // A changed piopd path makes the next command open a new SSH connection, as after a user edits a machine.
      settings.hosts = [{ enabled: true, id: 'server', name: 'Server', target: 'server', piPath: round % 2 ? '~/.bun/bin/../bin/piopd' : '~/.bun/bin/piopd' }];
      if (round % 2) settings.hosts.push({ enabled: true, id: 'offline', name: 'Offline', target: 'offline', piPath: 'pi' });
      const saved = await daemon.invoke('save_app_settings', { settings });
      results.push(await daemon.invoke('home_directory', { hostId: 'server' }).then(() => 'answered', (error: Error) => error.message));
      await synchronizationFinished(daemon, saved.revision);
    }
  } finally { await useRemotes(daemon, [server]); }
  expect(results).toEqual(['answered', 'answered', 'answered', 'answered']);
});


const onServer = (command: string, args: any) => daemon.invoke(command, { ...args, hostId: 'server', clientId: 'test-client' });
const serverFailure = (command: string, args: any) => daemon.failure(command, { ...args, hostId: 'server', clientId: 'test-client' });


test('remote session commands accept only transcripts inside the matching storage area and keep literal names', async () => {
  const outside = join(server.home, 'outside.jsonl'); writeFileSync(outside, 'precious');
  for (const [area, command, expected] of [['sessions', 'delete_session', 'Only piop session files'], ['archived', 'delete_archived_session', 'Only archived piop conversations']] as const) {
    const root = join(server.home, '.piop', area, 'checks'); mkdirSync(root, { recursive: true });
    const wrong = join(root, 'wrong.json'); writeFileSync(wrong, 'keep');
    const folder = join(root, 'directory.jsonl'); mkdirSync(folder, { recursive: true });
    const escape = join(root, 'escape.jsonl'); symlinkSync(outside, escape);
    for (const path of [outside, wrong, folder, escape]) expect(await serverFailure(command, { sessionPath: path })).toStartWith(expected);
    expect(await serverFailure(command, { sessionPath: join(root, 'missing.jsonl') })).toStartWith('Could not locate');
    expect(readFileSync(wrong, 'utf8')).toBe('keep');
  }
  const literal = publicSession(server.home, { cwd: server.home, folder: "nested ' $(touch injected) 日本語" });
  expect(await serverFailure('delete_archived_session', { sessionPath: literal.path })).toStartWith('Only archived');
  const alias = join(dirname(literal.path), 'alias.jsonl'); symlinkSync(literal.path, alias);
  expect(await onServer('delete_session', { sessionPath: alias })).toEqual([literal.path]);
  expect(existsSync(literal.path)).toBe(false);
  expect(readFileSync(outside, 'utf8')).toBe('precious');
  expect(existsSync(join(server.home, 'injected'))).toBe(false);
});

test('remote relocation changes only the header and keeps permissions and line endings', async () => {
  const project = join(server.home, "project ' $(touch injected) 日本語"); mkdirSync(project);
  // Pi ends every line with a newline; a header without one is an interrupted write, which the daemon refuses.
  for (const body of ['\n', '\n{"type":"message","text":"hello 日本語"}\n']) {
    const previousProject = join(server.home, 'old-relocate');
    mkdirSync(previousProject);
    const session = publicSession(server.home, { cwd: previousProject, folder: 'relocate' });
    rmdirSync(previousProject);
    const storedHeader = JSON.parse(readFileSync(session.path, 'utf8').split('\n')[0]!);
    const header = JSON.stringify({ ...storedHeader, custom: true });
    writeFileSync(session.path, header + body);
    chmodSync(session.path, 0o640);
    await onServer('relocate_session', { sessionPath: session.path, cwd: '  ' + project + '  ' });
    const content = readFileSync(session.path, 'utf8');
    const newline = content.indexOf('\n');
    const [first, rest] = newline < 0 ? [content, ''] : [content.slice(0, newline), content.slice(newline + 1)];
    expect(JSON.parse(first)).toEqual({ ...JSON.parse(header!), cwd: project });
    expect(rest).toBe(body.replace(/^\n/, ''));
    expect(content.endsWith('\n')).toBe(true);
    expect(statSync(session.path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(session.path)).filter(name => name.includes('.tmp'))).toEqual([]);
  }
  expect(existsSync(join(server.home, 'injected'))).toBe(false);
});

test('invalid remote relocations change no file', async () => {
  const previousProject = join(server.home, 'old-relocate-invalid');
  mkdirSync(previousProject);
  const session = publicSession(server.home, { cwd: previousProject, folder: 'relocate-invalid' });
  rmdirSync(previousProject);
  const original = readFileSync(session.path, 'utf8');
  for (const content of ['bad JSON\nunchanged', 'null\n', '{"type":"message"}\n']) {
    writeFileSync(session.path, content);
    await expect(onServer('relocate_session', { sessionPath: session.path, cwd: server.home })).rejects.toThrow();
    expect(readFileSync(session.path, 'utf8')).toBe(content);
  }
  writeFileSync(session.path, original);
  expect(await serverFailure('relocate_session', { sessionPath: session.path, cwd: '/missing/piop-project' })).toContain('Project directory does not exist');
  const outside = join(server.home, 'outside-relocate.jsonl'); writeFileSync(outside, original);
  expect(await serverFailure('relocate_session', { sessionPath: outside, cwd: server.home })).toStartWith('Only piop session files');
  const alias = join(dirname(session.path), 'alias-outside.jsonl'); symlinkSync(outside, alias);
  await expect(onServer('relocate_session', { sessionPath: alias, cwd: server.home })).rejects.toThrow();
  expect(readFileSync(outside, 'utf8')).toBe(original);
  expect(readFileSync(session.path, 'utf8')).toBe(original);
});

test('the session list combines reachable machines, skips failing ones, sorts by recency and shows groups', async () => {
  const empty = await remoteMachine(daemon, 'empty', 'Empty');
  try {
    await useRemotes(daemon, [server, empty, { id: 'offline', name: 'Offline', target: 'offline', unreachable: true }]);
    const content = JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Keep this listed chat' } }) + '\n';
    const local = publicSession(daemon.home, { cwd: daemon.home, folder: 'aggregate', content });
    const recent = publicSession(server.home, { cwd: server.home, folder: 'aggregate', content });
    const old = publicSession(server.home, { cwd: server.home, folder: 'aggregate', content });
    utimesSync(local.path, 20, 20); utimesSync(recent.path, 30, 30); utimesSync(old.path, 10, 10);
    let groups = await daemon.invoke('load_session_groups', { seeds: [] });
    groups = await daemon.invoke('change_session_groups', { change: { type: 'create', name: 'Local group' } });
    const localGroup = groups.groups[0].id;
    groups = await daemon.invoke('change_session_groups', { change: { type: 'create', name: 'Server group' } });
    const serverGroup = groups.groups[0].id;
    await daemon.invoke('change_session_groups', { change: { type: 'assign', key: 'local:' + local.id, group: localGroup } });
    await daemon.invoke('change_session_groups', { change: { type: 'assign', key: 'server:' + recent.id, group: serverGroup } });
    const rows = (await waitForSessions(daemon, rows => [local.id, recent.id, old.id].every(id => rows.some(row => row.id === id)))).filter((row: any) => [local.id, recent.id, old.id].includes(row.id));
    expect(rows.filter((row: any) => row.hostId === 'server').map((row: any) => row.id)).toEqual([recent.id, old.id]);
    expect(rows.map((row: any) => row.hostId).sort()).toEqual(['local', 'server', 'server']);
    const byId = new Map(rows.map((row: any) => [row.id, row]));
    expect(byId.get(recent.id)).toMatchObject({ hostName: 'Server', groupId: serverGroup });
    expect(byId.get(local.id)).toMatchObject({ hostName: 'Local', groupId: localGroup });
    // A listed chat that nobody assigned joins the project of its folder.
    expect(byId.get(old.id)).toMatchObject({ groupId: 'server:' + server.home });
    expect(await daemon.waitEvent('pi://daemon-error', payload => payload.hostId === 'offline')).toMatchObject({ line: expect.stringContaining('Could not attach to Offline') });
  } finally { await useRemotes(daemon, [server]); await empty.stop(); }
});


test('remote home lookup returns the remote home directory', async () => {
  expect(await daemon.invoke('home_directory', { hostId: 'server' })).toBe(realpathSync(server.home));
});

test('remote directory listing without a path opens remote home', async () => {
  expect((await daemon.invoke('list_directories', { hostId: 'server' })).path).toBe(realpathSync(server.home));
});

test('remote directory listing with an empty path opens remote home', async () => {
  expect((await daemon.invoke('list_directories', { hostId: 'server', path: '' })).path).toBe(realpathSync(server.home));
});

test('remote directory listing with a whitespace path opens remote home', async () => {
  expect((await daemon.invoke('list_directories', { hostId: 'server', path: '  ' })).path).toBe(realpathSync(server.home));
});

test('remote directory listing reports a missing directory', async () => {
  const path = join(server.home, crypto.randomUUID());
  await expect(daemon.invoke('list_directories', { hostId: 'server', path })).rejects.toThrow('Could not browse');
});

test('remote directory listing rejects a regular file without changing it', async () => {
  const path = join(server.home, crypto.randomUUID());
  writeFileSync(path, 'unchanged');
  await expect(daemon.invoke('list_directories', { hostId: 'server', path })).rejects.toThrow('is not a directory');
  expect(readFileSync(path, 'utf8')).toBe('unchanged');
});

test('remote directory listing reports an unreadable folder and lists it again once readable', async () => {
  const locked = join(realpathSync(server.home), 'unreadable-listing'); mkdirSync(join(locked, 'child'), { recursive: true });
  chmodSync(locked, 0o300);
  let failure: string;
  try { failure = await daemon.failure('list_directories', { hostId: 'server', path: locked }); } finally { chmodSync(locked, 0o700); }
  expect(failure).toStartWith('Could not browse ' + locked + ':');
  expect(failure).toContain('EACCES');
  expect(await daemon.invoke('list_directories', { hostId: 'server', path: locked }))
    .toEqual({ path: locked, parent: realpathSync(server.home), directories: [join(locked, 'child')] });
});

test('local cleanup preserves files in an unallocated neighboring directory', async () => {
  const allocated = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const unallocated = join(dirname(allocated.cwd), crypto.randomUUID());
  mkdirSync(unallocated);
  writeFileSync(join(unallocated, 'keep'), 'untouched');

  expect(await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: unallocated })).toBeNull();
  expect(readFileSync(join(unallocated, 'keep'), 'utf8')).toBe('untouched');
});

test('remote cleanup preserves files in an unallocated neighboring directory', async () => {
  const allocated = await daemon.invoke('create_temporary_chat', { hostId: 'server' });
  const unallocated = join(dirname(allocated.cwd), crypto.randomUUID());
  mkdirSync(unallocated);
  writeFileSync(join(unallocated, 'keep'), 'untouched');

  expect(await daemon.invoke('remove_temporary_chat', { hostId: 'server', path: unallocated })).toBeNull();
  expect(readFileSync(join(unallocated, 'keep'), 'utf8')).toBe('untouched');
});
