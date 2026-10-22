import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteMachine, startDaemon, useRemotes } from './harness';

test.concurrent('project selection rejects links into app storage but accepts similarly named folders', async () => {
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

test.concurrent('a remote machine rejects its own app storage as a project even where the local machine accepts the same path', async () => {
  const daemon = await startDaemon();
  const server = await remoteMachine(daemon, 'server', 'Server');
  try {
    await useRemotes(daemon, [server]);
    const child = join(server.home, '.piop', 'project');
    const alias = join(server.home, 'storage-link');
    const sibling = join(server.home, '.piop-project');
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling);
    symlinkSync(child, alias);
    for (const path of [child, alias]) {
      expect(await daemon.failure('validate_project_directory', { hostId: 'server', path }))
        .toBe('Piop storage directories cannot be selected as projects');
    }
    expect(await daemon.invoke('validate_project_directory', { hostId: 'server', path: sibling })).toBe(sibling);
    // The local machine has its own storage, so the remote storage folder is an ordinary folder there.
    expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: child })).toBe(child);

    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'server' });
    expect(chat.cwd.startsWith(join(server.home, '.piop', 'tmp') + '/')).toBe(true);
    expect(await daemon.invoke('validate_project_directory', { hostId: 'server', path: chat.cwd, allowStorage: true })).toBe(chat.cwd);
    expect(await daemon.failure('validate_project_directory', { hostId: 'server', path: chat.cwd }))
      .toBe('Piop storage directories cannot be selected as projects');
  } finally { await server.stop(); await daemon.stop(); }
}, 60_000);

test.concurrent('project selection rejects folders reached through the real location of a linked app storage folder', async () => {
  const daemon = await startDaemon();
  try {
    const relocated = join(daemon.home, 'relocated-storage');
    const project = join(relocated, 'project');
    mkdirSync(project, { recursive: true });
    symlinkSync(relocated, join(daemon.home, '.piop-dev'));
    for (const path of [relocated, project]) {
      expect(await daemon.failure('validate_project_directory', { hostId: 'local', path }))
        .toBe('Piop storage directories cannot be selected as projects');
    }
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('allowing app storage accepts a temporary chat folder but still rejects files and missing paths', async () => {
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
