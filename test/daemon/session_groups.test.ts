import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop(), 60_000);

const load = (seeds: any[] = []) => daemon.invoke('load_session_groups', { seeds });
const change = (value: any) => daemon.invoke('change_session_groups', { change: value });
const project = (id: string, name: string, cwd: string | null, hostId: string | null = 'local', hostName: string | null = null) => ({ id, name, cwd, hostId, hostName });
const names = (state: any) => state.groups.map((group: any) => group.name);
/** Deletes every group so each test starts from an empty but loaded state. */
async function reset(): Promise<any> {
  let state = await load();
  for (const group of state.groups) state = await change({ type: 'remove', id: group.id });
  return state;
}

// Assignments of sessions that do not exist on their machine are cleaned up, so tests use real session IDs.
function publicSession(cwd = daemon.home): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, cwd, folder: 'groups', content: '' }),
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
  expect(group(unknown.id)).toBeNull();
  expect(listed.find((row: any) => row.id === shared.id)).toMatchObject({ hostId: 'local', name: 'Untitled session' });
  state = await load();
  expect(state.assignments['local:' + shared.id]).toBe(first);
});

test('removing a project ungroups its sessions but lets new sessions discover it again', async () => {
  await reset();
  const repo = join(daemon.home, 'repo'); mkdirSync(repo, { recursive: true });
  const first = publicSession(repo); const second = publicSession(repo);
  const repository = () => project('local:' + repo, 'Repository', repo);
  await change({ type: 'project', project: repository(), key: 'local:' + first.id });
  const removed = await change({ type: 'remove', id: 'local:' + repo });
  expect(removed.groups).toEqual([]); expect(removed.removedProjects).toEqual([]);
  expect(removed.assignments['local:' + first.id]).toBeNull();
  const discovered = await load([{ sessionKey: 'local:' + second.id, project: repository() }]);
  expect(discovered.groups).toHaveLength(1);
  expect(discovered.assignments['local:' + second.id]).toBe('local:' + repo);
  const restored = await change({ type: 'project', project: repository(), key: 'local:' + first.id });
  expect(restored.groups).toHaveLength(1); expect(restored.removedProjects).toEqual([]);
  expect(restored.assignments['local:' + first.id]).toBe('local:' + repo);
  expect(restored.assignments['local:' + second.id]).toBe('local:' + repo);
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
  expect(names(state)).toEqual(['Forgotten', 'New', 'repo']);
  expect(state.assignments['local:' + created.id]).toBe('local:' + fresh);
  expect(state.assignments['local:' + ungrouped.id]).toBeNull();
  expect(state.assignments['local:' + returned.id]).toBe('local:' + forgotten);
  expect(state.removedProjects).toEqual([]);
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
