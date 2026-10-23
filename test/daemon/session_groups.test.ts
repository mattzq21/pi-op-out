import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { startDaemon, waitForSessions, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop(), 60_000);

const load = (seeds: any[] = []) => daemon.invoke('load_session_groups', { seeds });
const change = (value: any) => daemon.invoke('change_session_groups', { change: value });
const project = (id: string, name: string, cwd: string | null, hostId: string | null = 'local', hostName: string | null = null) => ({ id, name, cwd, hostId, hostName });
const names = (state: any) => state.groups.map((group: any) => group.name);
/** Deletes every group, and forgets removed projects, so each test starts from an empty but loaded state. */
async function reset(): Promise<any> {
  let state = await load();
  for (const group of state.groups) state = await change({ type: 'remove', id: group.id });
  const db = new Database(join(daemon.home, '.piop/sessions.sqlite'));
  try { db.exec('DELETE FROM session_group_removed_projects'); } finally { db.close(); }
  return load();
}

// Assignments of sessions that do not exist on their machine are cleaned up, so tests use real session IDs.
function publicSession(cwd = daemon.home): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, cwd, folder: 'groups', content: JSON.stringify({ type: 'message', message: { role: 'user', content: 'Hello' } }) + '\n' }),
  }));
}


test('concurrent group changes keep every update and tell clients each saved state', async () => {
  await reset();
  const start = daemon.events.length;
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => change({ type: 'create', name: 'Group ' + index })));
  results.forEach((state, index) => expect(names(state)).toContain('Group ' + index));
  const state = await load();
  expect(state.groups).toHaveLength(12);
  expect(new Set(state.groups.map((group: any) => group.id)).size).toBe(12);
  await daemon.waitEvent('pi://groups-changed', payload => payload.groups.length === 12);
  const notified = daemon.events.slice(start).filter(event => event.event === 'pi://groups-changed').map(event => event.payload.groups.length);
  expect(notified).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
});

test('a removed project is not registered again when its chats are listed', async () => {
  await reset();
  const folder = join(daemon.home, 'removed-project'); mkdirSync(folder, { recursive: true });
  const first = publicSession(folder);
  await waitForSessions(daemon, rows => rows.some(row => row.id === first.id));
  await daemon.waitEvent('pi://groups-changed', payload => payload.groups.some((group: any) => group.cwd === folder));
  const removed = await change({ type: 'remove', id: 'local:' + folder });
  expect(removed.groups.some((group: any) => group.cwd === folder)).toBe(false);
  const second = publicSession(folder);
  await waitForSessions(daemon, rows => rows.some(row => row.id === second.id));
  const after = await daemon.invoke('load_session_groups', { seeds: [] });
  expect(after.groups.some((group: any) => group.cwd === folder)).toBe(false);
  expect(after.assignments['local:' + second.id]).toBeNull();
});

test('listing a chat in an unseen folder registers its project without a client', async () => {
  await reset();
  const folder = join(daemon.home, 'unseen-project'); mkdirSync(folder, { recursive: true });
  const chat = publicSession(folder);
  await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  const notified = await daemon.waitEvent('pi://groups-changed', payload => payload.groups.some((group: any) => group.cwd === folder));
  expect(notified.groups.find((group: any) => group.cwd === folder)).toEqual(project('local:' + folder, 'unseen-project', folder, 'local', 'Local'));
  expect((await load()).assignments['local:' + chat.id]).toBe('local:' + folder);
});

test('a folder named like a temporary chat folder but without a random UUID is a project', async () => {
  await reset();
  const folder = join(daemon.home, '.piop/tmp/12345678-1234-1123-8123-123456789abc'); mkdirSync(folder, { recursive: true });
  const chat = publicSession(folder);
  await waitForSessions(daemon, rows => rows.some(row => row.id === chat.id));
  await daemon.waitEvent('pi://groups-changed', payload => payload.groups.some((group: any) => group.cwd === folder));
  expect((await load()).assignments['local:' + chat.id]).toBe('local:' + folder);
});

test('failed group changes do not notify and do not change saved groups', async () => {
  const fresh = await startDaemon();
  try {
    expect(await fresh.failure('change_session_groups', { change: { type: 'create', name: 'First' } })).toContain('not loaded');
    await fresh.invoke('load_session_groups', { seeds: [] });
    const start = fresh.events.length;
    expect(await fresh.failure('change_session_groups', { change: { type: 'create', name: ' ' } })).toBe('Enter a group name');
    expect((await fresh.invoke('load_session_groups', { seeds: [] })).groups).toEqual([]);
    const state = await fresh.invoke('change_session_groups', { change: { type: 'create', name: 'First' } });
    expect(names(state)).toEqual(['First']);
    const notified = await fresh.waitEvent('pi://groups-changed');
    expect(names(notified)).toEqual(['First']);
    expect(fresh.events.slice(start).filter(event => event.event === 'pi://groups-changed')).toHaveLength(1);
  } finally { await fresh.stop(); }
}, 60_000);

test('the session list shows the group of each session by machine and session', async () => {
  await reset();
  const shared = publicSession(); const ungrouped = publicSession(); const unknown = publicSession();
  let state = await change({ type: 'create', name: 'First' });
  const first = state.groups[0].id;
  await change({ type: 'assign', key: 'local:' + shared.id, group: first });
  await change({ type: 'assign', key: 'local:' + ungrouped.id, group: null });
  const listed = (await daemon.invoke('list_sessions')).filter((row: any) => [shared.id, ungrouped.id, unknown.id].includes(row.id));
  const group = (id: string) => listed.find((row: any) => row.id === id).groupId;
  expect(group(shared.id)).toBe(first);
  expect(group(ungrouped.id)).toBeNull();
  expect(group(unknown.id)).toBe('local:' + daemon.home);
  expect(listed.find((row: any) => row.id === shared.id)).toMatchObject({ hostId: 'local', name: 'Hello' });
  state = await load();
  expect(state.assignments['local:' + shared.id]).toBe(first);
});

test('removing a project ungroups its sessions and keeps it removed until it is added again', async () => {
  await reset();
  const repo = join(daemon.home, 'repo'); mkdirSync(repo, { recursive: true });
  const first = publicSession(repo); const second = publicSession(repo);
  const repository = () => project('local:' + repo, 'Repository', repo);
  await change({ type: 'project', project: repository(), key: 'local:' + first.id });
  const removed = await change({ type: 'remove', id: 'local:' + repo });
  expect(removed.groups).toEqual([]); expect(removed.removedProjects).toEqual(['local:' + repo]);
  expect(removed.assignments['local:' + first.id]).toBeNull();
  const discovered = await load([{ sessionKey: 'local:' + second.id, project: repository() }]);
  expect(discovered.groups).toHaveLength(0);
  expect(discovered.assignments['local:' + second.id]).toBeNull();
  await change({ type: 'assign', key: 'local:' + second.id, group: null });
  const restored = await change({ type: 'project', project: repository(), key: 'local:' + first.id });
  expect(restored.groups).toHaveLength(1); expect(restored.removedProjects).toEqual([]);
  expect(restored.assignments['local:' + first.id]).toBe('local:' + repo);
  await change({ type: 'assign', key: 'local:' + first.id, group: null });
  const reloaded = await load([{ sessionKey: 'local:' + first.id, project: repository() }]);
  expect(reloaded.assignments['local:' + first.id]).toBeNull();
});

test('project updates keep user names and do not duplicate groups', async () => {
  await reset();
  const repo = join(daemon.home, 'repo-names'); mkdirSync(repo, { recursive: true });
  const id = 'local:' + repo;
  await change({ type: 'project', project: project(id, 'My name', repo), key: null });
  let state = await change({ type: 'project', project: project(id, 'Discovered name', repo), key: null });
  expect(names(state)).toEqual(['My name']);
  const fresh = publicSession(repo);
  state = await load([{ sessionKey: 'local:' + fresh.id, project: project(id, 'Other', repo) }]);
  expect(state.groups).toHaveLength(1); expect(state.assignments['local:' + fresh.id]).toBe(id);
  const other = (await change({ type: 'create', name: 'Other' })).groups[0].id;
  expect(await daemon.failure('change_session_groups', { change: { type: 'rename', id: other, name: 'MY NAME' } })).toBe('A group already uses that name');
  expect(names(await load())).toEqual(['Other', 'My name']);
  expect(names(await change({ type: 'rename', id, name: 'MY NAME' }))).toEqual(['Other', 'MY NAME']);
});

test('loading assigns new sessions to their projects and keeps explicit ungrouping', async () => {
  await reset();
  const repo = join(daemon.home, 'legacy-repo'); const fresh = join(daemon.home, 'legacy-new'); const forgotten = join(daemon.home, 'legacy-forgotten');
  for (const path of [repo, fresh, forgotten]) mkdirSync(path, { recursive: true });
  const [ungrouped, created, returned] = [publicSession(repo), publicSession(fresh), publicSession(forgotten)];
  await change({ type: 'project', project: project('local:' + repo, 'repo', repo), key: null });
  await change({ type: 'assign', key: 'local:' + ungrouped.id, group: null });
  await change({ type: 'project', project: project('local:' + forgotten, 'Forgotten', forgotten), key: null });
  await change({ type: 'remove', id: 'local:' + forgotten });
  const state = await load([
    { sessionKey: 'local:' + ungrouped.id, project: project('local:' + repo, 'Workspace', repo) },
    { sessionKey: 'local:' + created.id, project: project('local:' + fresh, 'New', fresh) },
    { sessionKey: 'local:' + returned.id, project: project('local:' + forgotten, 'Forgotten', forgotten) },
  ]);
  expect(names(state)).toEqual(['New', 'repo']);
  expect(state.assignments['local:' + created.id]).toBe('local:' + fresh);
  expect(state.assignments['local:' + ungrouped.id]).toBeNull();
  expect(state.assignments['local:' + returned.id]).toBeNull();
  expect(state.removedProjects).toEqual(['local:' + forgotten]);
  expect(await load()).toEqual(state);
});

test('group changes save creation, renaming, assignment and removal', async () => {
  await reset();
  const chat = publicSession();
  const state = await change({ type: 'create', name: ' First ' });
  const id = state.groups[0].id;
  expect(state.groups[0].name).toBe('First');
  expect(typeof id).toBe('string');
  expect(id.trim()).not.toBe('');
  await change({ type: 'assign', key: 'local:' + chat.id, group: id });
  const renamed = await change({ type: 'rename', id, name: ' Renamed ' });
  expect(renamed.groups[0].name).toBe('Renamed'); expect(renamed.assignments['local:' + chat.id]).toBe(id);
  const removed = await change({ type: 'remove', id });
  expect(removed.groups).toEqual([]); expect(removed.assignments['local:' + chat.id]).toBeNull(); expect(removed.removedProjects).toEqual([]);
  expect(await load()).toEqual(removed);
});

test('invalid group changes leave the saved groups unchanged', async () => {
  await reset();
  const id = (await change({ type: 'create', name: 'Existing' })).groups[0].id;
  const before = await load();
  for (const invalid of [
    { type: 'create', name: ' ' }, { type: 'create', name: 'eXISTING' },
    { type: 'rename', id, name: ' ' }, { type: 'rename', id: 'missing', name: 'Name' },
    { type: 'remove', id: 'missing' }, { type: 'assign', key: 'local:chat', group: 'missing' },
    { type: 'project', project: project('bad', 'Bad', null) },
  ]) {
    await expect(change(invalid), JSON.stringify(invalid)).rejects.toThrow();
    expect(await load()).toEqual(before);
  }
});

test('a rename that reuses another group name keeps sessions grouped, tells no client, and a corrected rename keeps them in place', async () => {
  await reset();
  const alphaChat = publicSession(); const betaChat = publicSession();
  const alpha = (await change({ type: 'create', name: 'Alpha' })).groups[0].id;
  const beta = (await change({ type: 'create', name: 'Beta' })).groups[0].id;
  await change({ type: 'assign', key: 'local:' + alphaChat.id, group: alpha });
  await change({ type: 'assign', key: 'local:' + betaChat.id, group: beta });
  const listedGroups = async () => Object.fromEntries((await daemon.invoke('list_sessions'))
    .filter((row: any) => [alphaChat.id, betaChat.id].includes(row.id)).map((row: any) => [row.id, row.groupId]));
  const before = await load();
  const start = daemon.events.length;

  expect(await daemon.failure('change_session_groups', { change: { type: 'rename', id: beta, name: ' alpha ' } })).toBe('A group already uses that name');
  expect(await load()).toEqual(before);
  expect(await listedGroups()).toEqual({ [alphaChat.id]: alpha, [betaChat.id]: beta });
  expect(daemon.events.slice(start).filter(event => event.event === 'pi://groups-changed')).toEqual([]);

  const renamed = await change({ type: 'rename', id: beta, name: 'Gamma' });
  expect(renamed.groups).toEqual([{ id: beta, name: 'Gamma', cwd: null, hostId: null, hostName: null }, { id: alpha, name: 'Alpha', cwd: null, hostId: null, hostName: null }]);
  expect(renamed.assignments).toEqual(before.assignments);
  const notified = await daemon.waitEvent('pi://groups-changed', payload => payload.groups.some((group: any) => group.name === 'Gamma'));
  expect(notified).toEqual(renamed);
  expect(daemon.events.slice(start).filter(event => event.event === 'pi://groups-changed').map(event => event.payload)).toEqual([renamed]);
  expect(await listedGroups()).toEqual({ [alphaChat.id]: alpha, [betaChat.id]: beta });
});

test('moving project assignments keeps the old project until its last session moves', async () => {
  await reset();
  const first = publicSession();
  const second = publicSession();
  const oldProject = project('local:/old-project', 'Old project', '/old-project');
  const newProject = project('local:/new-project', 'New project', '/new-project');
  await change({ type: 'project', project: oldProject, key: 'local:' + first.id });
  await change({ type: 'project', project: oldProject, key: 'local:' + second.id });

  await change({ type: 'relocate', project: newProject, key: 'local:' + first.id });
  const partial = await load();
  expect(partial.assignments).toMatchObject({
    ['local:' + first.id]: newProject.id,
    ['local:' + second.id]: oldProject.id,
  });
  expect(names(partial).sort()).toEqual(['New project', 'Old project']);

  await change({ type: 'relocate', project: newProject, key: 'local:' + second.id });
  const finished = await load();
  expect(finished.groups).toEqual([newProject]);
  expect(finished.assignments).toMatchObject({
    ['local:' + first.id]: newProject.id,
    ['local:' + second.id]: newProject.id,
  });
});

test('changing a chat project preserves its user-chosen group', async () => {
  await reset();
  const chat = publicSession();
  const custom = (await change({ type: 'create', name: 'Important' })).groups[0];
  const key = 'local:' + chat.id;
  await change({ type: 'assign', key, group: custom.id });
  const before = await load();
  const destination = project('local:' + daemon.home, 'Home project', daemon.home);

  await change({ type: 'relocate', project: destination, key });
  const reloaded = await load([{ sessionKey: key, project: destination }]);
  expect(reloaded).toEqual(before);
  expect(reloaded.assignments[key]).toBe(custom.id);
});

test('changing a chat project keeps an explicitly ungrouped chat ungrouped', async () => {
  await reset();
  const chat = publicSession();
  const key = 'local:' + chat.id;
  await change({ type: 'assign', key, group: null });
  const destination = project('local:' + daemon.home, 'Home project', daemon.home);

  await change({ type: 'relocate', project: destination, key });
  const reloaded = await load([{ sessionKey: key, project: destination }]);
  expect(reloaded.assignments).toHaveProperty(key, null);
  expect(reloaded.groups).toEqual([]);
});

test('saved groups keep project metadata, machine names and explicit ungrouping', async () => {
  await reset();
  const one = publicSession(); const two = publicSession();
  await change({ type: 'project', project: project('server:/repo', 'Project α', '/repo', 'server', 'Server'), key: 'server:' + one.id });
  await change({ type: 'assign', key: 'local:' + two.id, group: null });
  const state = await load();
  expect(state.groups).toEqual([{ id: 'server:/repo', name: 'Project α', cwd: '/repo', hostId: 'server', hostName: 'Server' }]);
  expect(state.assignments['server:' + one.id]).toBe('server:/repo');
  expect(state.assignments['local:' + two.id]).toBeNull();
  const replaced = await reset();
  expect(replaced.groups).toEqual([]);
});


test('a group change fails while another process holds the session database, keeps saved groups and tells no client', async () => {
  const before = await reset();
  const start = daemon.events.length;
  const other = new Database(join(daemon.home, '.piop/sessions.sqlite'));
  other.exec('BEGIN IMMEDIATE');
  let error: string;
  try { error = await daemon.failure('change_session_groups', { change: { type: 'create', name: 'Blocked' } }); }
  finally { other.exec('ROLLBACK'); other.close(); }
  expect(error).toBe('database is locked');
  expect(await load()).toEqual(before);
  expect(daemon.events.slice(start).filter(event => event.event === 'pi://groups-changed')).toEqual([]);
  expect(names(await change({ type: 'create', name: 'After' }))).toEqual(['After']);
}, 30_000);

test('a branch takes its source chat\'s group, and its own worktree folder never becomes a group', async () => {
  await reset();
  const repo = join(daemon.home, 'branch-repo'); const worktreeRoot = join(daemon.home, 'worktrees');
  mkdirSync(repo, { recursive: true });
  const worktree = (id: string) => { const path = join(worktreeRoot, id); mkdirSync(path, { recursive: true }); return path; };
  const [inProject, inCustom, ungrouped] = [publicSession(repo), publicSession(repo), publicSession(repo)];
  const custom = (await change({ type: 'create', name: 'Release work' })).groups[0].id;
  const branches = [publicSession(), publicSession(), publicSession(), publicSession()];
  const [fromProject, fromCustom, fromUngrouped, fromBranch] = branches.map(branch => ({ ...branch, cwd: worktree(branch.id) }));
  const seed = (session: { id: string }, cwd: string, parent?: { id: string }) =>
    ({ sessionKey: 'local:' + session.id, project: project('local:' + cwd, cwd.split('/').at(-1)!, cwd), ...(parent ? { parentKey: 'local:' + parent.id } : {}) });
  await load([seed(inProject, repo), seed(inCustom, repo), seed(ungrouped, repo)]);
  await change({ type: 'assign', key: 'local:' + inCustom.id, group: custom });
  await change({ type: 'assign', key: 'local:' + ungrouped.id, group: null });

  // A branch of a branch is listed before its own source here; its group still comes from the chain.
  const state = await load([seed(fromBranch, fromBranch.cwd, fromProject), seed(fromProject, fromProject.cwd, inProject),
    seed(fromCustom, fromCustom.cwd, inCustom), seed(fromUngrouped, fromUngrouped.cwd, ungrouped), seed(inProject, repo)]);
  expect(state.assignments['local:' + fromProject.id]).toBe('local:' + repo);
  expect(state.assignments['local:' + fromBranch.id]).toBe('local:' + repo);
  expect(state.assignments['local:' + fromCustom.id]).toBe(custom);
  expect(state.assignments['local:' + fromUngrouped.id]).toBeNull();
  expect(state.groups.filter((group: any) => group.cwd?.startsWith(worktreeRoot))).toEqual([]);

  // A branch the user moves stays where it was moved.
  await change({ type: 'assign', key: 'local:' + fromProject.id, group: custom });
  expect((await load([seed(fromProject, fromProject.cwd, inProject)])).assignments['local:' + fromProject.id]).toBe(custom);
});

test('a branch whose source has no group yet waits, then takes the source\'s group once the source loads', async () => {
  await reset();
  const repo = join(daemon.home, 'late-repo');
  mkdirSync(repo, { recursive: true });
  const [source, branch] = [publicSession(repo), publicSession()];
  const branchSeed = { sessionKey: 'local:' + branch.id, project: project('local:' + daemon.home + '/wt', 'wt', daemon.home), parentKey: 'local:' + source.id };
  const waiting = await load([branchSeed]);
  expect('local:' + branch.id in waiting.assignments).toBe(false);
  expect(waiting.groups).toEqual([]);
  const state = await load([branchSeed, { sessionKey: 'local:' + source.id, project: project('local:' + repo, 'late-repo', repo) }]);
  expect(state.assignments['local:' + branch.id]).toBe('local:' + repo);
  expect(names(state)).toEqual(['late-repo']);
});

test('a branch on another machine takes the group of its source on that machine', async () => {
  await reset();
  const [source, branch] = ['devbox:' + crypto.randomUUID(), 'devbox:' + crypto.randomUUID()];
  const remote = (cwd: string) => project('devbox:' + cwd, cwd.split('/').at(-1)!, cwd, 'devbox', 'Devbox');
  await load([{ sessionKey: source, project: remote('/srv/app') }]);
  const state = await load([{ sessionKey: branch, project: remote('/home/dev/.local/share/piop/worktrees/' + branch.slice(7)), parentKey: source }]);
  expect(state.assignments[branch]).toBe('devbox:/srv/app');
  expect(names(state)).toEqual(['app']);
  expect(await daemon.failure('load_session_groups', { seeds: [{ sessionKey: branch, project: remote('/srv/app'), parentKey: branch }] })).toContain('branched from itself');
});
