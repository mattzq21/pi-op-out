import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.stop(); });

test('browsing a folder lists only its folders, including linked ones, in name order', async () => {
  const root = join(daemon.home, 'browse');
  for (const name of ['beta', 'Alpha', 'gamma']) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, 'notes.txt'), '');
  symlinkSync(join(root, 'gamma'), join(root, 'delta'));
  symlinkSync(join(root, 'missing'), join(root, 'broken'));
  expect(await daemon.invoke('list_directories', { hostId: 'local', path: root })).toEqual({
    path: root, parent: daemon.home,
    directories: ['Alpha', 'beta', 'delta', 'gamma'].map(name => join(root, name)),
  });
}, 60000);

test('a project can be any folder except a file or Piop storage, even reached through a link', async () => {
  const project = join(daemon.home, 'code/app');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(daemon.home, 'code/readme.md'), '');
  mkdirSync(join(daemon.home, '.piop/notes'), { recursive: true });
  symlinkSync(join(daemon.home, '.piop/notes'), join(daemon.home, 'code/shortcut'));
  const choose = (path: string) => daemon.invoke('validate_project_directory', { hostId: 'local', path });
  expect(await choose(project)).toBe(project);
  expect(await daemon.failure('validate_project_directory', { hostId: 'local', path: join(daemon.home, 'code/readme.md') })).toBe('Project path is not a directory');
  for (const storage of [join(daemon.home, '.piop'), join(daemon.home, '.piop/notes'), join(daemon.home, 'code/shortcut')]) {
    expect(await daemon.failure('validate_project_directory', { hostId: 'local', path: storage })).toBe('Piop storage directories cannot be selected as projects');
  }
}, 60000);
