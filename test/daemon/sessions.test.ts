import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { startDaemon, type TestDaemon } from "./harness";
import { Database } from "bun:sqlite";

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop(), 60_000);

function publicSession(home: string, options: { cwd: string; folder?: string; entries?: unknown[] }): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, cwd: options.cwd, folder: options.folder ?? 'project', content: (options.entries ?? []).map(entry => JSON.stringify(entry) + '\n').join('') }),
  }));
}

const listed = async (path: string) => (await daemon.invoke('list_sessions')).filter((session: any) => session.path === path);

test('session list shows new transcripts, refreshes changed ones and drops deleted ones', async () => {
  const { id, path } = publicSession(daemon.home, { cwd: daemon.home });
  expect(await listed(path)).toEqual([]);
  execFileSync('node', [fileURLToPath(new URL('../fixtures/append-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home: daemon.home, path, message: { role: 'user', content: 'New question', timestamp: 1 } }),
  });
  const [updated] = await listed(path);
  expect(updated).toMatchObject({ id, name: 'New question', cwdExists: true, messageCount: 1, hostId: 'local', hostName: 'Local' });
  expect(await daemon.invoke('delete_sessions', { sessionIds: [id], hostId: 'local', clientId: 'test-client' })).toEqual([id]);
  expect(await daemon.waitEvent('pi://session-removed', payload => payload.sessionPath === path)).toEqual({ hostId: 'local', sessionPath: path, sessionId: id });
  expect(existsSync(path)).toBe(false);
  expect(await listed(path)).toEqual([]);
});

const ls = async () => (await daemon.invoke('list_sessions')) as any[];
const client = 'test-client';
const relocateError = (sessionPath: string) => daemon.failure('relocate_session', { sessionPath, cwd: daemon.home, hostId: 'local', clientId: client });

test('path commands accept only saved active transcripts inside the sessions folder', async () => {
  const directory = join(daemon.home, '.piop/sessions/validation'); mkdirSync(directory, { recursive: true });
  const outside = join(daemon.home, 'outside.jsonl'); writeFileSync(outside, 'outside');
  const wrongType = join(directory, 'chat.json'); writeFileSync(wrongType, '{}');
  const folder = join(directory, 'directory.jsonl'); mkdirSync(folder, { recursive: true });
  const escape = join(directory, 'escape.jsonl'); symlinkSync(outside, escape);
  for (const path of [wrongType, folder, outside, escape]) expect(await relocateError(path)).toStartWith('Only ');
  expect(await relocateError(join(directory, 'missing.jsonl'))).toStartWith('Could not locate');
  const toArchive = publicSession(daemon.home, { cwd: daemon.home, folder: 'validation-archived' });
  await archive(toArchive.id);
  expect(await relocateError(toArchive.path)).toBe('Only piop session files can be accessed');
  expect(await daemon.failure('delete_sessions', { sessionIds: [crypto.randomUUID()], hostId: 'local', clientId: client })).toBe('This conversation has been deleted');
  expect([readFileSync(outside, 'utf8'), readFileSync(wrongType, 'utf8'), existsSync(toArchive.path)]).toEqual(['outside', '{}', true]);
});

const archive = (sessionId: string) => daemon.invoke('archive_session', { sessionId, hostId: 'local', terminalIds: [], clientId: client });

test('archiving keeps conversations where they are and takes them off the session list', async () => {
  const first = publicSession(daemon.home, { cwd: daemon.home, folder: 'archive-a', entries: [{ type: 'message', message: { role: 'user', content: 'first conversation' } }] });
  await archive(first.id);
  expect(await daemon.waitEvent('pi://session-removed', payload => payload.sessionId === first.id)).toMatchObject({ sessionPath: first.path });
  expect(readFileSync(first.path, 'utf8')).toContain('first conversation');
  expect((await ls()).some(session => session.id === first.id)).toBe(false);
  const archives = (await daemon.invoke('storage_report', { archivesOnly: true })).hosts[0].archives;
  expect(archives.find((row: any) => row.id === first.id)).toMatchObject({ path: first.path, name: 'first conversation' });
});

const settings = async (args: any = {}) => daemon.invoke('load_app_settings', args);
const save = async (next: any) => daemon.invoke('save_app_settings', { settings: next });

test('skill rediscovery keeps choices, drops skills outside the skills folder and refreshes metadata', async () => {
  const root = join(daemon.home, '.agents/skills');
  mkdirSync(join(root, 'existing'), { recursive: true }); mkdirSync(join(root, 'new'), { recursive: true });
  writeFileSync(join(root, 'existing/SKILL.md'), '---\nname: Alpha\ndescription: Updated metadata\n---\n');
  writeFileSync(join(root, 'new/SKILL.md'), '---\nname: beta\n---\n');
  const current = await settings({ refreshSkills: true });
  await save({ ...current, skills: [
    { name: 'Old metadata', path: '~/.agents/skills/existing', description: 'Old', enabled: false },
    { name: 'Deleted', path: '~/.agents/skills/deleted', description: 'Gone', enabled: true },
    { name: 'Manual', path: '/custom/skill', description: 'Mine', enabled: false },
  ] });
  const once = (await settings({ refreshSkills: true })).skills;
  expect(once.map((skill: any) => skill.name)).toEqual(['Alpha', 'beta']);
  expect(once[0]).toMatchObject({ enabled: false, description: 'Updated metadata' });
  expect(once[1]).toMatchObject({ enabled: true });
  expect((await settings({ refreshSkills: true })).skills).toEqual(once);
  for (const name of ['existing', 'new']) { unlinkSync(join(root, name, 'SKILL.md')); rmdirSync(join(root, name)); }
  const after = (await settings({ refreshSkills: true })).skills;
  expect(after).toEqual([]);
});

test('skills that only users may invoke stay enabled', async () => {
  const root = join(daemon.home, '.agents/skills/explicit'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '---\nname: Explicit\ndisable-model-invocation: true\n---\n');
  const current = await settings({ refreshSkills: true });
  await save({ ...current, skills: [{ name: 'Explicit', path: '~/.agents/skills/explicit', description: 'x', enabled: false }] });
  const explicit = (await settings({ refreshSkills: true })).skills.find((skill: any) => skill.name === 'Explicit');
  expect(explicit).toMatchObject({ userInvokedOnly: true, enabled: true });
  unlinkSync(join(root, 'SKILL.md')); rmdirSync(root);
  await settings({ refreshSkills: true });
});

test('settings never save tools and load the tools that Pi reported on the host', async () => {
  const current = await settings();
  await save({ ...current, tools: [{ name: 'invented', description: 'Not reported by Pi', source: 'builtin:invented' }] });
  const loaded = await settings();
  expect(loaded.tools.some((tool: any) => tool.name === 'invented')).toBe(false);
  expect(loaded.tools).toEqual(current.tools);
});

test('settings default when absent and reject too many remote hosts', async () => {
  const fresh = await startDaemon();
  try {
    const loaded = await fresh.invoke('load_app_settings');
    expect(loaded.hosts).toEqual([]);
    const hosts = Array.from({ length: 17 }, (_, index) => ({ enabled: true, id: 'remote-' + index, name: 'Remote ' + index, target: 'host' + index, piPath: 'pi' }));
    expect(await fresh.failure('save_app_settings', { settings: { ...loaded, hosts } })).toContain('remote hosts');
    expect((await fresh.invoke('load_app_settings')).hosts).toEqual([]);
  } finally { await fresh.stop(); }
}, 60_000);

const relocate = (sessionPath: string, cwd: string) => daemon.invoke('relocate_session', { sessionPath, cwd, hostId: 'local', clientId: client });

test('relocating a session changes only the header working directory', async () => {
  const project = join(daemon.home, 'new project 日本語'); mkdirSync(project);
  const tail = '{"type":"message","text":"hello 🌍"}\n\n{"custom": true}\n';
  const previousProject = join(daemon.home, 'old-relocate');
  mkdirSync(previousProject);
  const session = publicSession(daemon.home, { cwd: previousProject, folder: 'relocate' });
  rmdirSync(previousProject);
  const header = { ...JSON.parse(readFileSync(session.path, 'utf8').split('\n')[0]!), custom: { keep: true } };
  writeFileSync(session.path, JSON.stringify(header) + '\n' + tail);
  chmodSync(session.path, 0o640);
  await relocate(session.path, '  ' + project + '  ');
  const [first, ...rest] = readFileSync(session.path, 'utf8').split('\n');
  expect(JSON.parse(first!)).toEqual({ ...header, cwd: project });
  expect(rest.join('\n')).toBe(tail);
  expect(readdirSync(dirname(session.path))).toEqual([basename(session.path)]);
  expect(statSync(session.path).mode & 0o777).toBe(0o640);
});

test('invalid relocations leave the original session untouched and a corrected retry relocates it', async () => {
  const previousProject = join(daemon.home, 'old-relocate-invalid');
  mkdirSync(previousProject);
  const session = publicSession(daemon.home, { cwd: previousProject, folder: 'relocate-invalid', entries: [{ type: 'message', message: { role: 'user', content: 'Kept question' } }] });
  rmdirSync(previousProject);
  const original = readFileSync(session.path, 'utf8');
  for (const content of [Buffer.from('invalid json'), Buffer.from('{"type":"message"}'), Buffer.from('[]'), Buffer.from([0xff])]) {
    writeFileSync(session.path, content);
    await expect(relocate(session.path, daemon.home)).rejects.toThrow();
    expect(readFileSync(session.path)).toEqual(content);
    expect(readdirSync(dirname(session.path))).toEqual([basename(session.path)]);
  }
  writeFileSync(session.path, original);
  for (const replacement of [join(daemon.home, 'missing'), session.path]) {
    await expect(relocate(session.path, replacement)).rejects.toThrow('Project directory does not exist');
    expect(readFileSync(session.path, 'utf8')).toBe(original);
    expect(await listed(session.path)).toMatchObject([{ id: session.id, cwd: previousProject, cwdExists: false, name: 'Kept question', messageCount: 1 }]);
  }
  const corrected = join(daemon.home, 'corrected-relocate'); mkdirSync(corrected);
  await relocate(session.path, corrected);
  expect(await listed(session.path)).toMatchObject([{ id: session.id, cwd: corrected, cwdExists: true, name: 'Kept question', messageCount: 1 }]);
  const outside = join(daemon.home, 'outside-relocate.jsonl'); writeFileSync(outside, '{"type":"session"}');
  await expect(relocate(outside, daemon.home)).rejects.toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('{"type":"session"}');
});

const settingsDatabase = () => join(daemon.home, '.piop/sessions.sqlite');

test('session list takes machine and file time from the daemon and gives defaults for missing transcript fields', async () => {
  const { id, path } = publicSession(daemon.home, { cwd: daemon.home, folder: 'defaults' });
  const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!);
  writeFileSync(path, JSON.stringify({ ...header, cwd: '', hostId: 'untrusted', hostName: 'Untrusted', modifiedAt: 999, fingerprint: 'untrusted' }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: '' } }) + '\n');
  const [row] = await listed(path);
  expect(row).toMatchObject({ id, path, name: 'Untitled session', preview: '', project: 'Unknown project', cwd: 'Unknown project', cwdExists: false, messageCount: 1, lastMessageAt: 0, apiCost: 0, hostId: 'local', hostName: 'Local' });
  expect(row).not.toHaveProperty('fingerprint');
});

test('session list reads transcripts whose folder names are full of quotes', async () => {
  const folder = "'".repeat(200) + ' "$(touch injected)" ' + "'".repeat(20);
  const sessions = Array.from({ length: 3 }, () => publicSession(daemon.home, { cwd: daemon.home, folder, entries: [{ type: 'message', message: { role: 'user', content: 'Quoted' } }] }));
  for (const { id, path } of sessions) expect(await listed(path)).toEqual([expect.objectContaining({ id, name: 'Quoted', messageCount: 1 })]);
  expect(existsSync(join(daemon.home, 'injected'))).toBe(false);
});

test('session list is empty without the local machine and remote machines', async () => {
  const settings = await daemon.invoke('load_app_settings');
  publicSession(daemon.home, { cwd: daemon.home, folder: 'hidden' });
  await daemon.invoke('save_app_settings', { settings: { ...settings, localEnabled: false, hosts: [] } });
  try { expect(await ls()).toEqual([]); }
  finally { await daemon.invoke('save_app_settings', { settings: { ...(await daemon.invoke('load_app_settings')), localEnabled: true, hosts: settings.hosts } }); }
});

test('session list fails when it cannot read session groups, and works again after', async () => {
  const { path } = publicSession(daemon.home, { cwd: daemon.home, folder: 'locked', entries: [{ type: 'message', message: { role: 'user', content: 'Locked' } }] });
  expect(await listed(path)).toHaveLength(1);
  const other = new Database(settingsDatabase());
  other.exec('BEGIN IMMEDIATE');
  let error: string;
  try { error = await daemon.failure('list_sessions'); }
  finally { other.exec('ROLLBACK'); other.close(); }
  expect(error).toBe('database is locked');
  expect(await listed(path)).toHaveLength(1);
}, 30_000);
