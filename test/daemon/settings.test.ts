import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop());

const load = () => daemon.invoke('load_app_settings');
const save = (settings: any) => daemon.invoke('save_app_settings', { settings });
const remote = (host: Record<string, unknown> = {}) => ({ enabled: false, id: 'remote', name: 'Server', target: 'user@host', piPath: 'pi', ...host });

test('retired default model is dropped when settings are saved', async () => {
  const settings = await load();
  expect(settings).not.toHaveProperty('defaultModel');
  const change = await save({ ...settings, defaultModel: 'retired/model' });
  expect(change.settings).not.toHaveProperty('defaultModel');
  expect(await load()).not.toHaveProperty('defaultModel');
});

test('invalid settings are rejected and the saved settings stay unchanged', async () => {
  const before = await load();
  const cases: Array<[string, (settings: any) => void, string]> = [
    ['context cap', settings => { settings.contextWindowCap = 999; }, 'from 100,000 to 50,000,000'],
    ['reserved search shortcut', settings => { settings.keybindings.newConversation = 'META+g'; }, 'reserved for conversation search'],
    ['duplicate shortcut', settings => { settings.keybindings.newConversation = ' Shift + CTRL + n '; settings.keybindings.toggleTerminal = 'ctrl+shift+N'; }, 'assigned more than once'],
    ['shortcut without modifier', settings => { settings.keybindings.newConversation = 'n'; }, 'needs Ctrl, Alt, or Meta'],
    ['repeated modifier still duplicates', settings => { settings.keybindings.toggleTerminal = 'Ctrl+Ctrl+N'; }, 'assigned more than once'],
    ['modifier only', settings => { settings.keybindings.newConversation = 'Ctrl'; }, 'needs exactly one key'],
    ['non ASCII key without modifier', settings => { settings.keybindings.newConversation = 'Shift+é'; }, 'needs Ctrl, Alt, or Meta'],
    ['emoji', settings => { settings.keybindings.newConversation = '🦆'; }, 'needs Ctrl, Alt, or Meta'],
    ['function key alone', settings => { settings.keybindings.newConversation = 'F2'; }, 'needs Ctrl, Alt, or Meta'],
    ['plus alone', settings => { settings.keybindings.newConversation = ' + '; }, 'needs Ctrl, Alt, or Meta'],
    ['machine named Local', settings => { settings.hosts = [remote({ name: ' LoCaL ' })]; }, 'already in use'],
    ['machine id local', settings => { settings.hosts = [remote({ id: 'LOCAL' })]; }, "'local' is reserved"],
    ['blank machine id', settings => { settings.hosts = [remote({ id: ' ' })]; }, 'unique id'],
    ['blank machine name', settings => { settings.hosts = [remote({ name: ' ' })]; }, 'needs a name'],
    ['shell in SSH target', settings => { settings.hosts = [remote({ target: 'host;id' })]; }, 'SSH target'],
    ['arguments in Pi executable', settings => { settings.hosts = [remote({ piPath: 'pi --flag' })]; }, 'Pi executable'],
    ['duplicate machine id', settings => { settings.hosts = [remote(), remote({ name: 'Other' })]; }, 'unique id'],
    ['duplicate machine name', settings => { settings.hosts = [remote(), remote({ id: 'other', name: ' SERVER ' })]; }, 'already in use'],
    ['too many machines', settings => { settings.hosts = Array.from({ length: 17 }, (_, index) => remote({ id: 'remote-' + index, name: 'Server ' + index })); }, 'At most 16'],
  ];
  cases.push(['invalid model alias', settings => { settings.modelAliases = { 'p/model': 42 } as any; }, 'modelAliases']);
  for (const [name, change, expected] of cases) {
    const settings = structuredClone(before);
    change(settings);
    expect(await daemon.failure('save_app_settings', { settings }), name).toContain(expected);
    expect(await load(), name).toEqual(before);
  }
});

test('valid edge-case shortcuts, a minimum context cap and machines are saved', async () => {
  const settings = await load();
  settings.contextWindowCap = 100_000;
  Object.assign(settings.keybindings, { newConversation: 'Ctrl+F2', toggleTerminal: 'Ctrl++', toggleDebugMode: ' ' });
  settings.hosts = [remote(), remote({ id: 'other', name: 'Other', target: 'user@[::1]:22', piPath: '~/.local/bin/pi' })];
  await save(settings);
  const saved = await load();
  expect(saved.contextWindowCap).toBe(100_000);
  expect(saved.keybindings).toMatchObject({ newConversation: 'Ctrl+F2', toggleTerminal: 'Ctrl++', toggleDebugMode: ' ' });
  expect(saved.hosts.map((host: any) => host.id)).toEqual(['remote', 'other']);
});

test('saving drops retired shortcut actions and moves Ctrl+L focus to Ctrl+E before it validates', async () => {
  const settings = await load();
  Object.assign(settings.keybindings, { retiredAction: 'Ctrl+G', focusComposer: 'Ctrl+L' });
  const change = await save(settings);
  expect(change.settings.keybindings.retiredAction).toBeUndefined();
  expect(change.settings.keybindings.focusComposer).toBe('Ctrl+E');
  const saved = await load();
  expect(saved.keybindings.retiredAction).toBeUndefined();
  expect(saved.keybindings.focusComposer).toBe('Ctrl+E');
  saved.keybindings.focusComposer = 'Alt+E';
  await save(saved);
  expect((await load()).keybindings.focusComposer).toBe('Alt+E');
});

test('each save tells clients the new settings with a rising revision', async () => {
  const changes: any[] = [];
  for (let index = 0; index < 4; index++) {
    const settings = await load();
    const model = 'model-' + changes.length;
    settings.reviewAgent = model;
    const change = await save(settings);
    expect(change.settings.reviewAgent).toBe(model);
    expect((await load()).reviewAgent).toBe(model);
    await daemon.waitEvent('pi://settings-changed', payload => payload.settings.reviewAgent === model);
    changes.push(change);
  }
  const [first, none, local, second] = changes;
  for (const change of changes) expect(change.agentConfigChange).toBeUndefined();
  expect(none.committedRevision).toBe(first.committedRevision + 1);
  expect(local.committedRevision).toBe(first.committedRevision + 2);
  expect(second.committedRevision).toBe(first.committedRevision + 3);
  expect(second).toMatchObject({ committed: true, synchronizationPending: false, warnings: [] });
  const snapshot = await daemon.invoke('load_settings_change');
  expect(snapshot).toMatchObject({ settings: await load(), committed: true, revision: second.revision, synchronizationPending: false, warnings: [] });
  expect(snapshot.phaseRevision).toBeGreaterThanOrEqual(second.phaseRevision);
});

test('a save based on outdated settings is rejected and keeps the newer settings', async () => {
  const stale = await load();
  const fresh = structuredClone(stale);
  fresh.reviewAgent = 'fresh-model';
  await save(fresh);
  stale.reviewAgent = 'stale-model';
  expect(await daemon.failure('save_app_settings', { settings: stale })).toContain('Settings changed in another window or client');
  expect((await load()).reviewAgent).toBe('fresh-model');
});

test('a save that cannot lock the settings fails, keeps the settings and tells no client', async () => {
  const before = await load();
  const lock = join(daemon.home, '.piop/settings.lock');
  rmSync(lock, { force: true });
  mkdirSync(lock);
  try {
    const changed = { ...before, reviewAgent: 'unsaved-model' };
    const seen = daemon.events.length;
    expect(await daemon.failure('save_app_settings', { settings: changed })).toStartWith('Could not lock settings');
    expect(daemon.events.slice(seen).filter(event => event.event === 'pi://settings-changed')).toEqual([]);
  } finally { rmSync(lock, { recursive: true }); }
  expect(await load()).toEqual(before);
});

test('a save fails and keeps the settings while another process holds the settings database', async () => {
  const before = await load();
  const baseline = await daemon.invoke('load_settings_change');
  const other = new Database(join(daemon.home, '.piop/sessions.sqlite'));
  other.exec('BEGIN IMMEDIATE');
  let error: string;
  try { error = await daemon.failure('save_app_settings', { settings: { ...before, reviewAgent: 'unsaved-model' } }); }
  finally { other.exec('ROLLBACK'); other.close(); }
  expect(error).toBe('database is locked');
  expect(await load()).toEqual(before);
  const failed = await daemon.invoke('load_settings_change');
  expect(failed.revision).toBe(baseline.revision);
  expect(failed.settings).toEqual(baseline.settings);
  const retried = await save({ ...before, reviewAgent: 'retried-model' });
  expect(retried.committedRevision).toBe(baseline.revision + 1);
  const after = await daemon.invoke('load_settings_change');
  expect(after.revision).toBe(baseline.revision + 1);
  expect(after.settings.reviewAgent).toBe('retried-model');
  expect((await load()).reviewAgent).toBe('retried-model');
}, 30_000);

test('skill front matter is read only inside its header and keeps quoted values', async () => {
  const root = join(daemon.home, '.agents/skills');
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  write('named/SKILL.md', "---\nignored line\nother: value\nname: 'A skill'\ndescription: \"Useful description\"\n---\nname: wrong");
  write('fallback/SKILL.md', 'name: outside the header');
  const skills = (await daemon.invoke('load_app_settings', { refreshSkills: true })).skills;
  expect(skills.find((skill: any) => skill.path === join(root, 'named'))).toMatchObject({ name: 'A skill', description: 'Useful description' });
  expect(skills.find((skill: any) => skill.path === join(root, 'fallback'))).toMatchObject({ name: 'fallback', description: 'Pi skill' });
});

test('a skill disabled by a home-relative path stays disabled after discovery', async () => {
  const root = join(daemon.home, '.agents/skills/home-relative');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), 'Body');
  const settings = await daemon.invoke('load_app_settings', { refreshSkills: true });
  settings.skills = [{ name: 'home-relative', path: '~/.agents/skills/home-relative', description: 'Pi skill', enabled: false }];
  await save(settings);
  const skills = (await load()).skills.filter((skill: any) => skill.name === 'home-relative');
  expect(skills).toEqual([expect.objectContaining({ path: root, enabled: false })]);
});
