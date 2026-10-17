import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from './harness';

test('project selection rejects links into app storage but accepts similarly named folders', async () => {
  const daemon = await startDaemon();
  try {
    for (const name of ['.piop', '.piop-dev']) {
      const storage = join(daemon.home, name);
      const child = join(storage, 'project');
      const alias = join(daemon.home, name + '-link');
      const sibling = join(daemon.home, name + '-project');
      mkdirSync(child, { recursive: true });
      mkdirSync(sibling);
      symlinkSync(child, alias);
      for (const path of [storage, child, alias]) {
        expect(await daemon.failure('validate_project_directory', { hostId: 'local', path }))
          .toBe('Piop storage directories cannot be selected as projects');
      }
      expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: sibling })).toBe(sibling);
    }
  } finally { await daemon.stop(); }
}, 60_000);

test('allowing app storage accepts a temporary chat folder but still rejects files and missing paths', async () => {
  const daemon = await startDaemon();
  try {
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const args = { hostId: 'local', allowStorage: true };
    expect(await daemon.invoke('validate_project_directory', { ...args, path: chat.cwd })).toBe(chat.cwd);
    expect(await daemon.failure('validate_project_directory', { path: chat.cwd, hostId: 'local' }))
      .toBe('Piop storage directories cannot be selected as projects');

    const file = join(chat.cwd, 'notes.txt');
    writeFileSync(file, 'Project notes');
    expect(await daemon.failure('validate_project_directory', { ...args, path: file }))
      .toContain('is not a directory');
    expect(await daemon.failure('validate_project_directory', { ...args, path: join(chat.cwd, 'missing') }))
      .toContain('is unavailable');
    expect(await daemon.invoke('validate_project_directory', { ...args, path: chat.cwd })).toBe(chat.cwd);
  } finally { await daemon.stop(); }
}, 60_000);
